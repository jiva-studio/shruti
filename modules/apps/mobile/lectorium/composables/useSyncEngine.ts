import { onBeforeUnmount, onMounted, watch } from "vue"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { backfillLocal, runSync } from "@usecases/sync/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import { onSyncEvent } from "@lectorium/services/syncEvents.js"

/** Light background cadence — a full sync cycle every few minutes while the
 *  app is foregrounded, so remote changes land without user action. */
const INTERVAL_MS = 3 * 60 * 1000
/** Coalesce a burst of local mutations into one push cycle. */
const DEBOUNCE_MS = 3000
/** Device-local marker prefix: `${…}${userId}` records that this account's
 *  pre-sync local rows have already been backfilled into the outbox on this
 *  device, so the one-time first-sync backfill never re-runs on a later launch. */
const BACKFILL_MARKER_PREFIX = "sync.backfilled."

/**
 * Trigger composable for the profile sync engine (Lane D). Mounted once in
 * `App.vue`, mirroring `useProactiveScheduler`. It ONLY triggers the use-case
 * — no merge / HLC / HTTP logic lives here.
 *
 * Fires `runSync` on: app launch, sign-in, a light foreground interval, each
 * `appStateChange` resume, and (debounced) after a local mutation emits
 * `sync-requested`. Ahead of each cycle it runs the one-time first-sync
 * backfill (Lane E2b) so an account's pre-sync local rows upload the first time
 * it signs in on this device.
 *
 * Gates (no-op unless ALL hold):
 *  - the account is signed-in and NOT anonymous (`auth.signedIn`);
 *  - the active region has a `profileBaseUrl` (no chat fallback);
 *  - the engine repositories exist (i.e. `getDeviceId` was wired).
 * When disabled it never calls `runSync`; `runSync` itself also no-ops on a
 * disabled gateway as a backstop.
 */
export function useSyncEngine(): void {
  const app = useLectorium()
  const auth = useAuthStore()

  let interval: ReturnType<typeof setInterval> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let unsubRequested: (() => void) | null = null
  let unwatchSignedIn: (() => void) | null = null
  /** Single-flight guard — overlapping cycles would double-push the outbox. */
  let inFlight = false
  /** In-memory echo of the once-per-account backfill marker: the account whose
   *  pre-sync rows we've already enqueued this process, so the common path skips
   *  the Preferences read. The persisted marker survives restarts. */
  let backfilledUserId: string | null = null

  function isEnabled(): boolean {
    if (!auth.signedIn) return false
    if (!app.activeServer.value.profileBaseUrl) return false
    try {
      // Present only when getDeviceId was wired at the composition root.
      return !!app.repositories().syncState
    } catch {
      // Repos not open yet (cold boot) — a later trigger retries.
      return false
    }
  }

  async function refreshStores(collections: readonly string[]): Promise<void> {
    // Stores don't observe SQLite; refresh the ones whose collection changed.
    if (collections.includes("playlist_items") || collections.includes("listening_sessions")) {
      await usePlaylistStore()
        .refresh()
        .catch(() => undefined)
    }
    if (collections.includes("notes")) {
      await useNotesStore()
        .refresh()
        .catch(() => undefined)
    }
    // Chat (Lane G): a merged session / message batch changes the history list.
    if (collections.includes("chat_sessions") || collections.includes("chat_messages")) {
      await useChatStore()
        .refreshSessions()
        .catch(() => undefined)
    }
  }

  /**
   * First-sync backfill (Lane E2b). The first time a real account is signed in
   * on this device, enqueue its pre-sync local rows (created while anonymous,
   * before journaling) into the outbox so the following `runSync` uploads them
   * under that account. Runs **once per account** — guarded by a device-local
   * `sync.backfilled.<userId>` marker — and only when the engine is enabled, so
   * it never fires while anonymous (Upgrade-in-place: the local rows belong to
   * whoever signs in on this device and upload under the new id).
   */
  async function maybeBackfill(): Promise<void> {
    if (!isEnabled()) return
    const userId = auth.userId
    if (!userId) return
    if (backfilledUserId === userId) return

    const markerKey = `${BACKFILL_MARKER_PREFIX}${userId}`
    const already = await app.preferences.get(markerKey).catch(() => null)
    if (already) {
      backfilledUserId = userId
      return
    }

    let repos
    try {
      repos = app.repositories()
    } catch {
      return
    }
    const { syncBackfill, syncOutbox, syncState, unitOfWork } = repos
    if (!syncBackfill || !syncOutbox || !syncState) return

    try {
      await backfillLocal({
        backfill: syncBackfill,
        outbox: syncOutbox,
        syncState,
        unitOfWork,
      })
      await app.preferences.set(markerKey, "1").catch(() => undefined)
      backfilledUserId = userId
    } catch (err) {
      // Non-fatal: leave the marker unset so the next cycle retries the
      // backfill; the reader's anti-join keeps a partial run idempotent.
      console.warn("[sync] backfill failed", err)
    }
  }

  async function sync(): Promise<void> {
    if (inFlight || !isEnabled()) return
    let repos
    try {
      repos = app.repositories()
    } catch {
      return
    }
    const { syncOutbox, syncState, syncApply, unitOfWork } = repos
    if (!syncOutbox || !syncState || !syncApply) return

    inFlight = true
    try {
      await maybeBackfill()
      await runSync({
        gateway: app.syncClient,
        outbox: syncOutbox,
        syncState,
        apply: syncApply,
        unitOfWork,
        refreshStores,
      })
    } catch (err) {
      console.warn("[sync] cycle failed", err)
    } finally {
      inFlight = false
    }
  }

  function requestDebounced(): void {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => void sync(), DEBOUNCE_MS)
  }

  onMounted(() => {
    void sync()
    interval = setInterval(() => void sync(), INTERVAL_MS)
    void CapApp.addListener("appStateChange", (state) => {
      if (state.isActive) void sync()
    }).then((handle) => {
      resumeHandle = handle
    })
    // A local mutation journaled a change — push it soon (coalesced).
    unsubRequested = onSyncEvent("sync-requested", requestDebounced)
    // Sign-in (anonymous → real account) runs the first full sync immediately.
    unwatchSignedIn = watch(
      () => auth.signedIn,
      (now, prev) => {
        if (now && !prev) void sync()
      }
    )
  })

  onBeforeUnmount(() => {
    if (interval !== null) {
      clearInterval(interval)
      interval = null
    }
    if (debounce !== null) {
      clearTimeout(debounce)
      debounce = null
    }
    void resumeHandle?.remove()
    resumeHandle = null
    unsubRequested?.()
    unsubRequested = null
    unwatchSignedIn?.()
    unwatchSignedIn = null
  })
}
