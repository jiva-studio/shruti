import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import { msToSec, splitSessionAtMidnights } from "@shruti/composables/listeningDaySplit.js"

export { startOfNextLocalDay } from "@shruti/composables/listeningDaySplit.js"

/** Persist a tick at most once per N ms while playing. */
const TICK_INTERVAL_MS = 15_000

export interface ListeningSessionTrackerDeps {
  /** Lazy resolver — repos may not be ready when the tracker is created. */
  getRepo: () => IListeningSessionRepository
}

export interface ListeningSessionTracker {
  start(args: { itemId: PlaylistItemId; positionMs: number }): Promise<void>
  forceStart(args: { itemId: PlaylistItemId; positionMs: number }): Promise<void>
  tick(args: { positionMs: number }): Promise<void>
  finish(args: { positionMs: number }): Promise<void>
  /** Close at `positionBeforeMs` and, when playback continues, reopen at
   *  `positionAfterMs` — a seek is a discontinuity, not continued listening. */
  seek(args: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }): Promise<void>
  /** Close the current session right now; safe to call when no session is open. */
  flushOnHide(args: { positionMs: number }): Promise<void>
  hasActiveSession(): boolean
  activeItemId(): PlaylistItemId | null
}

/**
 * Stateful wrapper around `IListeningSessionRepository` holding a pointer to
 * the currently-open session. Position is milliseconds in the player and
 * seconds in the journal; this is the boundary that converts.
 */
export function useListeningSessionTracker(
  deps: ListeningSessionTrackerDeps
): ListeningSessionTracker {
  let activeSessionId: ListeningSessionId | null = null
  let activeItemId: PlaylistItemId | null = null
  // Synchronous "a session is open OR an open() is in-flight, for this item",
  // claimed BEFORE the first await. `activeSessionId` lands only once the DB
  // insert resolves, so a burst of fire-and-forget progress events would
  // otherwise each pass the guard and open its own overlapping row.
  let openItemId: PlaylistItemId | null = null
  let lastTickAt = 0
  // Wall clock and track position at which the CURRENT row opened — the
  // anchor for the local-midnight split.
  let sessionOpenedAtMs = 0
  let sessionOpenPositionMs = 0

  // Serialize every mutation so the session pointer transitions in call order:
  // a `finish()` interleaving with an in-flight `start()` would see no session
  // and leave the row that lands afterwards open forever.
  let opQueue: Promise<unknown> = Promise.resolve()
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = opQueue.then(op, op)
    // Keep the tail alive regardless of this op's outcome so a rejected op
    // (e.g. a locked DB on finish) doesn't wedge the queue for later ops.
    opQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** A midnight-split continuation passes the BOUNDARY instant, so the next
   *  split measures elapsed audio from where the row began rather than from
   *  the moment the roll was detected. */
  function noteSessionOpen(positionMs: number, openedAtMs: number = Date.now()) {
    sessionOpenedAtMs = openedAtMs
    sessionOpenPositionMs = Math.max(0, positionMs)
  }

  async function splitAtMidnightIfNeeded(itemId: PlaylistItemId, currentPositionMs: number) {
    if (activeSessionId === null) return
    const next = await splitSessionAtMidnights(
      deps.getRepo(),
      {
        sessionId: activeSessionId,
        itemId,
        openedAtMs: sessionOpenedAtMs,
        openPositionMs: sessionOpenPositionMs,
      },
      currentPositionMs
    )
    activeSessionId = next.sessionId
    activeItemId = next.itemId
    sessionOpenedAtMs = next.openedAtMs
    sessionOpenPositionMs = next.openPositionMs
  }

  // ---- raw ops --------------------------------------------------------------
  // These mutate the session pointer directly and MUST run inside `serialize`
  // (never call each other through the public wrappers, or the queue would
  // wait on itself and deadlock).

  async function openRaw(
    itemId: PlaylistItemId,
    positionMs: number,
    { force }: { force: boolean }
  ) {
    if (!force && activeSessionId !== null) {
      // Caller forgot to close. Split the lingering session first so a span
      // across midnights isn't credited to today, and close it under the item
      // that was actually playing — not necessarily `itemId`.
      const lingeringItemId = activeItemId
      if (lingeringItemId !== null) await splitAtMidnightIfNeeded(lingeringItemId, positionMs)
      // The previous tick's position isn't known here, so close at this one.
      try {
        if (activeSessionId !== null) {
          await deps.getRepo().finish(activeSessionId, { position: msToSec(positionMs) })
        }
      } catch {
        // ignore — we'll still open a new session below
      }
    }
    // `forceStart` pins from = position (a discontinuity); `start` inherits
    // the item's high-water mark so a resume tiles without a gap.
    activeSessionId = force
      ? await deps.getRepo().forceStart({ itemId, position: msToSec(positionMs) })
      : await deps.getRepo().start({ itemId, position: msToSec(positionMs) })
    activeItemId = itemId
    openItemId = itemId
    lastTickAt = Date.now()
    noteSessionOpen(positionMs)
  }

  async function tickRaw(positionMs: number) {
    if (activeSessionId === null) return
    const now = Date.now()
    if (now - lastTickAt < TICK_INTERVAL_MS) return
    lastTickAt = now
    const itemId = activeItemId
    if (itemId !== null) await splitAtMidnightIfNeeded(itemId, positionMs)
    if (activeSessionId === null) return
    await deps.getRepo().tick(activeSessionId, { position: msToSec(positionMs) })
  }

  async function closeRaw(positionMs: number) {
    if (activeSessionId === null) return
    const itemId = activeItemId
    if (itemId !== null) await splitAtMidnightIfNeeded(itemId, positionMs)
    const id = activeSessionId
    activeSessionId = null
    activeItemId = null
    try {
      await deps.getRepo().finish(id, { position: msToSec(positionMs) })
    } catch (e) {
      // Restore the handle so a later tick/finish can still close this row
      // instead of orphaning it open.
      activeSessionId = id
      activeItemId = itemId
      openItemId = itemId
      throw e
    }
  }

  // ---- public API -----------------------------------------------------------

  async function start({ itemId, positionMs }: { itemId: PlaylistItemId; positionMs: number }) {
    // Already open or opening — the periodic tick advances it. Synchronous,
    // before any await: this is what stops a burst of progress events.
    if (openItemId === itemId) return
    openItemId = itemId // claim synchronously, before the awaited insert
    try {
      await serialize(() => openRaw(itemId, positionMs, { force: false }))
    } catch (e) {
      // Release the claim (unless a newer op moved it) so a retry isn't deduped.
      if (openItemId === itemId && activeSessionId === null) openItemId = activeItemId
      throw e
    }
  }

  async function forceStart({
    itemId,
    positionMs,
  }: {
    itemId: PlaylistItemId
    positionMs: number
  }) {
    openItemId = itemId
    try {
      await serialize(() => openRaw(itemId, positionMs, { force: true }))
    } catch (e) {
      if (openItemId === itemId && activeSessionId === null) openItemId = activeItemId
      throw e
    }
  }

  async function tick({ positionMs }: { positionMs: number }) {
    if (openItemId === null) return
    await serialize(() => tickRaw(positionMs))
  }

  async function finish({ positionMs }: { positionMs: number }) {
    if (openItemId === null && activeSessionId === null) return
    // Release the claim synchronously so a racing `start` (e.g. an immediate
    // replay) queues a fresh open AFTER this close rather than being deduped.
    openItemId = null
    await serialize(() => closeRaw(positionMs))
  }

  async function seek({
    itemId,
    positionBeforeMs,
    positionAfterMs,
    willKeepPlaying,
  }: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }) {
    // Claim/clear synchronously to match the post-seek state the caller expects.
    openItemId = willKeepPlaying ? itemId : null
    await serialize(async () => {
      if (activeSessionId !== null) {
        const id = activeSessionId
        activeSessionId = null
        activeItemId = null
        await deps.getRepo().finish(id, { position: msToSec(positionBeforeMs) })
      }
      if (willKeepPlaying) {
        await openRaw(itemId, positionAfterMs, { force: true })
      }
    })
  }

  async function flushOnHide({ positionMs }: { positionMs: number }) {
    await finish({ positionMs })
  }

  return {
    start,
    forceStart,
    tick,
    finish,
    seek,
    flushOnHide,
    // Synchronous intent, not just the committed row: the player reads these
    // to decide start-vs-tick on the next progress event.
    hasActiveSession: () => openItemId !== null || activeSessionId !== null,
    activeItemId: () => openItemId ?? activeItemId,
  }
}
