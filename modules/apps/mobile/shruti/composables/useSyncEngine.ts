import { onBeforeUnmount, onMounted, watch } from "vue"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { hasPendingLibraryItems, nextSyncDelayMs, runSync } from "@usecases/sync/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { onSyncEvent } from "@shruti/services/syncEvents.js"
import { useSyncChatsEnabled } from "@shruti/composables/useSyncChats.js"
import { createBackfillGuard } from "@shruti/composables/syncBackfill.js"
import { createChatGapCursor } from "@shruti/composables/syncChatGap.js"
import { createCursorOwnerGuard } from "@shruti/composables/syncCursorOwner.js"
/** Coalesce a burst of local mutations into one push cycle. */
const DEBOUNCE_MS = 3000
/**
 * Trigger composable for the profile sync engine (Lane D). Mounted once in
 * `App.vue`, mirroring `useProactiveScheduler`. It ONLY triggers the use-case
 * — no merge / HLC / HTTP logic lives here.
 *
 * Fires `runSync` on: app launch, a new `userId` appearing (anonymous
 * bootstrap or sign-in), a light foreground interval, each `appStateChange`
 * resume, and (debounced) after a local mutation emits `sync-requested`.
 *
 * Gates (no-op unless ALL hold): a user identity exists — anonymous included,
 * since sync keeps a server-side copy for anonymous devices too; the active
 * region has a `profileBaseUrl`; the engine repositories are wired.
 */
export function useSyncEngine(): void {
  const app = useShruti()
  const auth = useAuthStore()
  /** Device-local "Sync chats" toggle (default ON), read live so a flip in
   *  Settings gates the very next cycle — the same ref the journal decorator
   *  reads. */
  const syncChats = useSyncChatsEnabled()

  /** Self-rescheduling poll timer: its delay is recomputed after every cycle
   *  so a pending library item can shorten the cadence. */
  let pollTimeout: ReturnType<typeof setTimeout> | null = null
  /** Current pending short-poll backoff, or `null` when the last cycle found
   *  nothing pending (so the next pending run starts fast). */
  let pendingDelayMs: number | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let unsubRequested: (() => void) | null = null
  let unwatchUserId: (() => void) | null = null
  let unwatchSyncChats: (() => void) | null = null
  /** Single-flight guard — overlapping cycles would double-push the outbox. */
  let inFlight = false
  function isEnabled(): boolean {
    // Any user identity syncs — anonymous device accounts included, so their
    // data reaches the server even if they never sign in. Keyed on the token's
    // `sub`, which is a stable auth.users id for anonymous users too.
    if (!auth.userId) return false
    if (!app.activeServer.value.profileBaseUrl) return false
    try {
      // Present only when getDeviceId was wired at the composition root.
      return !!app.repositories().syncState
    } catch {
      // Repos not open yet (cold boot) — a later trigger retries.
      return false
    }
  }

  const ensureCursorOwner = createCursorOwnerGuard({
    app,
    identity: () => ({ userId: auth.userId, anonymous: !!auth.anonymous }),
    isEnabled,
  })
  const backfill = createBackfillGuard({ app, identity: () => auth.userId, isEnabled })
  const chatGap = createChatGapCursor(app)

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
    if (collections.includes("library_items") || collections.includes("library_memberships")) {
      // Personal library (epic #1236) is pull-only and server-owned. Refresh the
      // "My library" store so the shelf/list + status badges reflect the merged
      // rows (e.g. an item flipping processing → ready) on whatever screen is
      // up. The poll loop shortens the cadence while any item is pending so this
      // fires within seconds, not the flat idle interval.
      await useLibraryStore()
        .refresh()
        .catch(() => undefined)
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
      await ensureCursorOwner()
      await backfill.run()
      await runSync({
        gateway: app.syncClient,
        outbox: syncOutbox,
        syncState,
        apply: syncApply,
        unitOfWork,
        // Read after the guard: it may have just switched identities, and the
        // drain must belong to the account that owns the device now.
        ownerId: auth.userId,
        // …and re-read live between rounds: a cycle outlives the identity it
        // started under, while the transport uses whatever token is current.
        getLiveOwnerId: () => auth.userId,
        // Same gate the journal decorator reads, so the toggle governs both
        // directions, plus the watermark that recovers what was skipped.
        isChatSyncEnabled: () => syncChats.value,
        getChatGapCursor: chatGap.read,
        setChatGapCursor: chatGap.write,
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
    // A local mutation (e.g. the "Add to library" tap fires `requestSync`):
    // run a cycle soon AND re-arm the poll so, if it pulled in a pending
    // library item, we drop into the short cadence immediately rather than
    // waiting out the idle interval already scheduled.
    debounce = setTimeout(() => void resyncNow(), DEBOUNCE_MS)
  }

  /** Whether any personal-library item is still being ingested. Read straight
   *  off the repo each cycle (the table is tiny) so the poll cadence tracks the
   *  latest state without a store subscription. Best-effort: treat a not-yet-
   *  open DB / read error as "nothing pending" so we fall back to idle. */
  async function anyLibraryItemPending(): Promise<boolean> {
    try {
      const items = await app.repositories().libraryItems.listAll()
      return hasPendingLibraryItems(items)
    } catch {
      return false
    }
  }

  /**
   * Arm the next poll. The delay is short (and self-backing-off) while a
   * library item is pending, else the flat idle interval — see
   * `nextSyncDelayMs`. Runs on ANY screen: the engine is mounted once in
   * `App.vue`, independent of the current route.
   */
  async function scheduleNextPoll(): Promise<void> {
    if (pollTimeout !== null) {
      clearTimeout(pollTimeout)
      pollTimeout = null
    }
    const hasPending = await anyLibraryItemPending()
    const delay = nextSyncDelayMs(hasPending, pendingDelayMs)
    // Track the backoff only while pending; reset to null when idle so the next
    // pending run restarts at the short minimum.
    pendingDelayMs = hasPending ? delay : null
    pollTimeout = setTimeout(() => void pollTick(), delay)
  }

  /** One poll cycle then re-arm with a delay based on fresh pending state. */
  async function pollTick(): Promise<void> {
    await sync()
    await scheduleNextPoll()
  }

  /** Immediate cycle + re-arm — used by resume and the debounced local-change
   *  path so a fresh pull re-evaluates the cadence right away. */
  async function resyncNow(): Promise<void> {
    await sync()
    await scheduleNextPoll()
  }

  onMounted(() => {
    void resyncNow()
    void CapApp.addListener("appStateChange", (state) => {
      if (state.isActive) void resyncNow()
    }).then((handle) => {
      resumeHandle = handle
    })
    // A local mutation journaled a change — push it soon (coalesced).
    unsubRequested = onSyncEvent("sync-requested", requestDebounced)
    // A new identity appearing runs the first full sync immediately: the
    // anonymous bootstrap resolving on cold boot, or an anonymous→real
    // upgrade / account switch (a changing `userId`). onMounted's initial
    // sync() may fire before the async auth bootstrap sets `userId`, so this
    // watch is what kicks the first anonymous cycle.
    unwatchUserId = watch(
      () => auth.userId,
      (now, prev) => {
        if (now && now !== prev) void sync()
      }
    )
    // "Sync chats" turned back on — re-arm the one-time backfill so what was
    // written while it was off gets an outbox row, then run a cycle: the pull
    // rewinds to the gap floor and brings the missed conversations down.
    unwatchSyncChats = watch(
      () => syncChats.value,
      (now, prev) => {
        if (!now || prev !== false) return
        void backfill.rearmForChats().then(() => resyncNow())
      }
    )
  })

  onBeforeUnmount(() => {
    if (pollTimeout !== null) {
      clearTimeout(pollTimeout)
      pollTimeout = null
    }
    if (debounce !== null) {
      clearTimeout(debounce)
      debounce = null
    }
    void resumeHandle?.remove()
    resumeHandle = null
    unsubRequested?.()
    unsubRequested = null
    unwatchUserId?.()
    unwatchUserId = null
    unwatchSyncChats?.()
    unwatchSyncChats = null
  })
}
