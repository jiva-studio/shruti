import { onBeforeUnmount, onMounted, watch } from "vue"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import {
  adoptAnonymousChanges,
  backfillLocal,
  hasPendingLibraryItems,
  nextSyncDelayMs,
  runSync,
} from "@usecases/sync/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { onSyncEvent } from "@shruti/services/syncEvents.js"
/** Coalesce a burst of local mutations into one push cycle. */
const DEBOUNCE_MS = 3000
/** Device-local marker prefix: `${…}${userId}` records that this account's
 *  pre-sync local rows have already been backfilled into the outbox on this
 *  device, so the one-time first-sync backfill never re-runs on a later launch. */
const BACKFILL_MARKER_PREFIX = "sync.backfilled."
/** Device-local marker holding the `userId` that currently owns the pull
 *  cursor. `sync_state` is keyed by device, not account, but the cursor is a
 *  position in the server's GLOBAL change log scoped to ONE user's view — after
 *  a sign-out + sign-in as a different account (the DB is not wiped on
 *  sign-out) it would skip the new user's earlier changes. When the owner
 *  differs we reset the cursor so the new identity re-pulls from 0 — and
 *  retire the outbox rows the previous owner journaled. */
const CURSOR_OWNER_KEY = "sync.cursorOwner"
/** Whether the account in {@link CURSOR_OWNER_KEY} is anonymous ("1" / "0").
 *  Written on every observed identity, not only on a change, so a device
 *  upgrading from a build that didn't record it is stamped on its next cycle.
 *  Absent ⇒ unknown ⇒ treated as NOT anonymous, which only forgoes the
 *  handover below. */
const CURSOR_OWNER_ANON_KEY = "sync.cursorOwnerAnon"
/** Highest outbox id retired by an identity change that did NOT hand the
 *  journal over. Unstamped rows at or below it belong to some earlier account
 *  and must never be adopted by a later one (#1497) — `pushed_outbox_id` cannot
 *  answer that, since a plain push advances it too. */
const RETIRED_OUTBOX_KEY = "sync.retiredOutboxId"
const ANON_FLAG = "1"

/**
 * Trigger composable for the profile sync engine (Lane D). Mounted once in
 * `App.vue`, mirroring `useProactiveScheduler`. It ONLY triggers the use-case
 * — no merge / HLC / HTTP logic lives here.
 *
 * Fires `runSync` on: app launch, a new `userId` appearing (anonymous
 * bootstrap or sign-in), a light foreground interval, each `appStateChange`
 * resume, and (debounced) after a local mutation emits `sync-requested`. Ahead
 * of each cycle it runs the one-time first-sync backfill (Lane E2b) so an
 * account's pre-sync local rows upload the first time the engine runs for it on
 * this device.
 *
 * Gates (no-op unless ALL hold):
 *  - a user identity exists (`auth.userId`) — anonymous OR signed-in; sync is
 *    identity-agnostic and keeps a server-side copy for anonymous devices too;
 *  - the active region has a `profileBaseUrl` (no chat fallback);
 *  - the engine repositories exist (i.e. `getDeviceId` was wired).
 * When disabled it never calls `runSync`; `runSync` itself also no-ops on a
 * disabled gateway as a backstop.
 */
export function useSyncEngine(): void {
  const app = useShruti()
  const auth = useAuthStore()

  /** Self-rescheduling poll timer (replaces the old flat interval): its delay
   *  is recomputed after every cycle so a pending library item can shorten the
   *  cadence (see `scheduleNextPoll`). */
  let pollTimeout: ReturnType<typeof setTimeout> | null = null
  /** Current pending short-poll backoff, or `null` when the last cycle found
   *  nothing pending (so the next pending run starts fast). */
  let pendingDelayMs: number | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let unsubRequested: (() => void) | null = null
  let unwatchUserId: (() => void) | null = null
  /** Single-flight guard — overlapping cycles would double-push the outbox. */
  let inFlight = false
  /** In-memory echo of the once-per-account backfill marker: the account whose
   *  pre-sync rows we've already enqueued this process, so the common path skips
   *  the Preferences read. The persisted marker survives restarts. */
  let backfilledUserId: string | null = null
  /** In-memory echo of the cursor-owner marker: the account the local pull
   *  cursor currently belongs to, so the common path skips the Preferences read
   *  once confirmed. The persisted marker survives restarts. */
  let cursorOwnerId: string | null = null
  /** In-memory echo of that account's anonymity — part of the marker, so an
   *  upgrade-in-place (same id, `anonymous` flipping false) is re-recorded. */
  let cursorOwnerAnon: boolean | null = null

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

  /**
   * Cursor-ownership guard. `sync_state` is keyed by device, so its
   * `pull_cursor` survives a sign-out (which does NOT wipe the DB). The cursor
   * is a high-water mark in the server's GLOBAL change log for ONE account's
   * filtered view; reusing it for a different account that signs in on this
   * device would skip that account's changes with a lower `global_seq`. When
   * the current owner differs from the account the cursor was last set for,
   * reset `pull_cursor`/`acked_seq` to 0 so the new identity re-pulls its whole
   * history (apply is an idempotent LWW no-op on rows it already has).
   *
   * The push side moves the OTHER way: `pushed_outbox_id` is raised to the
   * outbox's tail, retiring the rows journaled before the stamp existed. Those
   * are the previous owner's notes and chat messages — a local wipe / account
   * deletion leaves un-pushed ones behind (#1497). It is never rewound.
   *
   * This guard runs on the engine's next cycle, which can be long after the
   * identity actually changed (a cycle already in flight swallows the trigger;
   * a region without `profileBaseUrl` disables the engine entirely) — by then
   * the NEW account may have journaled rows of its own. That is why the
   * watermark is a fallback and not the mechanism: every row written since the
   * 023 migration carries its `owner_id`, so push filters on ownership and a
   * late watermark cannot retire a row the current account wrote.
   *
   * **Anonymous → a different account is the exception** (#1627). Sign-in only
   * keeps the anonymous id when the human had no account yet; a returning one
   * is cross-linked to the account they already had, and the id changes. There
   * the previous owner is not a stranger — it is the same person, and retiring
   * its journal would strand every note, queued lecture and listening session
   * of the anonymous period on an account nobody can reach again. So that one
   * transition hands the journal over instead of retiring it (see
   * {@link adoptAnonymousChanges}); every other one behaves as before.
   *
   * Runs once per account per process (guarded by an in-memory echo + a
   * persisted `sync.cursorOwner` marker) and only when enabled.
   */
  async function maybeResetCursorForOwner(): Promise<void> {
    if (!isEnabled()) return
    const userId = auth.userId
    if (!userId) return
    const anonymous = !!auth.anonymous
    if (cursorOwnerId === userId && cursorOwnerAnon === anonymous) return

    const stored = await app.preferences.get(CURSOR_OWNER_KEY).catch(() => null)
    const storedAnon = await app.preferences.get(CURSOR_OWNER_ANON_KEY).catch(() => null)
    // Same account — including the in-place anonymous upgrade, where only the
    // flag moves. Nothing is stranded: the id the server knows is unchanged.
    if (stored === userId) {
      await recordOwner(userId, anonymous, storedAnon)
      return
    }

    let repos
    try {
      repos = app.repositories()
    } catch {
      return
    }
    const { syncApply, syncOutbox, syncState, unitOfWork } = repos
    if (!syncState) return

    try {
      // A first-ever owner (stored === null) owns everything journaled so far
      // (the pre-marker upgrade path), so neither side is touched; recording
      // ownership is what makes a later switch detectable.
      if (stored !== null) {
        const adopt =
          storedAnon === ANON_FLAG && syncOutbox && syncApply
            ? { outbox: syncOutbox, apply: syncApply }
            : null
        const outboxTail = syncOutbox ? await syncOutbox.latestId() : null
        const retiredId = adopt ? await readRetiredOutboxId() : 0
        await unitOfWork.run(async () => {
          await syncState.setPullCursor(0)
          await syncState.setAckedSeq(0)
          if (adopt) {
            // No watermark raise: the rows it would retire are exactly the ones
            // being handed over, and what stays unowned already sits under
            // `sync.retiredOutboxId`.
            await adoptAnonymousChanges({
              ...adopt,
              unitOfWork,
              fromOwnerId: stored,
              toOwnerId: userId,
              unownedAfterId: retiredId,
            })
            return
          }
          if (outboxTail === null) return
          // Clamp: `setPushedOutboxId` is a bare column write, and a tail
          // BELOW the current mark (a pruned or restored journal) would rewind
          // it and un-retire the previous account's unowned rows.
          const prev = await syncState.getPushedOutboxId()
          if (outboxTail > prev) await syncState.setPushedOutboxId(outboxTail)
        })
        if (!adopt && outboxTail !== null) await raiseRetiredOutboxId(outboxTail)
      }
      await recordOwner(userId, anonymous, storedAnon)
    } catch (err) {
      // Non-fatal: leave the marker unset so the next cycle retries the reset.
      // Everything it does is idempotent, so a resumed run is a no-op.
      console.warn("[sync] cursor owner reset failed", err)
    }
  }

  /** Persist (and echo) the identity the cursor now belongs to. */
  async function recordOwner(
    userId: string,
    anonymous: boolean,
    storedAnon: string | null
  ): Promise<void> {
    const flag = anonymous ? ANON_FLAG : "0"
    await app.preferences.set(CURSOR_OWNER_KEY, userId).catch(() => undefined)
    if (storedAnon !== flag) {
      await app.preferences.set(CURSOR_OWNER_ANON_KEY, flag).catch(() => undefined)
    }
    cursorOwnerId = userId
    cursorOwnerAnon = anonymous
  }

  async function readRetiredOutboxId(): Promise<number> {
    const raw = await app.preferences.get(RETIRED_OUTBOX_KEY).catch(() => null)
    const parsed = raw === null ? 0 : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  /** Never rewound — a wiped journal reports a tail of 0, and lowering the
   *  floor would re-expose a previous account's rows to a later handover. */
  async function raiseRetiredOutboxId(tail: number): Promise<void> {
    if (tail <= 0) return
    const current = await readRetiredOutboxId()
    if (tail <= current) return
    await app.preferences.set(RETIRED_OUTBOX_KEY, String(tail)).catch(() => undefined)
  }

  /**
   * First-sync backfill (Lane E2b). The first time the engine runs for an
   * account on this device, enqueue its pre-sync local rows (created before
   * journaling existed) into the outbox so the following `runSync` uploads them
   * under that id. Runs **once per account** — guarded by a device-local
   * `sync.backfilled.<userId>` marker — and only when the engine is enabled.
   * Fires for anonymous users too (their id is stable per device); on an
   * upgrade-in-place the id is unchanged, so a marker already exists and the
   * backfill does not re-run.
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
    const { syncBackfill, syncOutbox, syncState, syncApply, unitOfWork } = repos
    if (!syncBackfill || !syncOutbox || !syncState || !syncApply) return

    try {
      await backfillLocal({
        backfill: syncBackfill,
        outbox: syncOutbox,
        apply: syncApply,
        syncState,
        unitOfWork,
        ownerId: userId,
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
      await maybeResetCursorForOwner()
      await maybeBackfill()
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
        // started under, while the transport authenticates with whatever token
        // is current.
        getLiveOwnerId: () => auth.userId,
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
  })
}
