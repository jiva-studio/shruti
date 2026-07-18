import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

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
  /**
   * Close the current session at `positionBeforeMs` and, if the player
   * will keep playing, immediately open a new one starting at
   * `positionAfterMs`. Used by the player's `seek()` — a seek is an
   * explicit discontinuity, not continued listening.
   */
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

function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 1000)
}

/** Local-midnight (00:00:00.000) of the calendar day that `ms` falls on. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Local-midnight (00:00:00.000) of the calendar day AFTER the one `ms` falls
 * on. Derived by stepping the calendar date by one day and re-flooring to
 * local midnight, NOT by adding a fixed 24h — on DST-transition days a local
 * day is 23h or 25h long, so `startOfLocalDay(ms) + 86_400_000` would land an
 * hour early/late and split at the wrong wall-clock instant.
 */
export function startOfNextLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  // Re-floor in case the +1 day landed on a DST instant where 00:00 doesn't
  // exist / is ambiguous; setHours snaps back to the real local midnight.
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Stateful wrapper around `IListeningSessionRepository` that keeps an
 * in-memory pointer to the currently-open session id. The player calls
 * `start` on play, `tick` while playing (throttled), `finish` on
 * pause/track-change/visibility-hide, and `seek` on user seeks.
 *
 * Position is in milliseconds in the player; we convert to seconds at
 * this boundary so the journal stores compact integers.
 */
export function useListeningSessionTracker(
  deps: ListeningSessionTrackerDeps
): ListeningSessionTracker {
  let activeSessionId: ListeningSessionId | null = null
  let activeItemId: PlaylistItemId | null = null
  // Synchronous "a session is open OR an open() is in-flight, for this item".
  // The player drives us with FIRE-AND-FORGET progress events, and its
  // "is a session already open?" guard reads `hasActiveSession()`. But
  // `activeSessionId` is only assigned AFTER the awaited DB insert resolves,
  // so between calling `start()` and that insert completing the guard still
  // reports "no session". A burst of progress events (a seek/scrub, a resume
  // flushing buffered native events, or a duplicated progress listener) then
  // each passes the guard and opens its OWN row — all reading the same
  // pre-burst high-water mark, so hundreds of overlapping sessions land with
  // the same `from_position` and the activity total balloons. `openItemId` is
  // claimed BEFORE the first await, so those racing events see the session as
  // already open and route to `tick()` (a no-op until the row exists) instead
  // of opening duplicates.
  let openItemId: PlaylistItemId | null = null
  let lastTickAt = 0
  // Wall-clock (ms) and track position (ms) at which the *current* session
  // row opened. Used to split a session that crosses local midnight so each
  // calendar day keeps its own listening (see `splitAtMidnightIfNeeded`).
  let sessionOpenedAtMs = 0
  let sessionOpenPositionMs = 0

  // Serialize every mutation so the in-memory session pointer transitions in
  // call order. Without this a `finish()` racing an in-flight `start()` can
  // interleave their awaits — the finish sees `activeSessionId === null`
  // (the start hasn't committed yet), does nothing, and the start then
  // commits a row that never gets closed. Chaining forces open → close →
  // reopen to apply strictly in the order the player asked for them.
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

  /**
   * Record when/where the current session opened. `openedAtMs` defaults to
   * "now" for a freshly-started session, but a midnight-split continuation
   * passes the BOUNDARY wall-clock instant so the next split iteration
   * measures elapsed audio from the boundary it actually began at — not from
   * the moment we happened to detect the roll (which, after a multi-day
   * background gap, is "today" and would collapse every spanned day into one).
   */
  function noteSessionOpen(positionMs: number, openedAtMs: number = Date.now()) {
    sessionOpenedAtMs = openedAtMs
    sessionOpenPositionMs = Math.max(0, positionMs)
  }

  /**
   * If the current session opened on an earlier local calendar day than
   * `nowMs`, close it at the last second of the day it opened on and open a
   * continuation so each row stays within one local day. `getDailyTotals`
   * groups by `date(ended_at, 'localtime')`, so without the split a session
   * spanning midnight would credit ALL of its time to the post-midnight day
   * and the pre-midnight day could lose a streak.
   *
   * The split LOOPS over every crossed local-midnight: when the app is
   * backgrounded and the next tick/finish lands days later, a single split
   * would credit one pre-midnight slice to day N-1 and dump the entire
   * remainder onto today, leaving every intervening day at zero (re-breaking
   * streaks/heatmap). Instead we emit one row per spanned local day, and each
   * continuation's open-time is the boundary it began at (not the detection
   * time) so the next iteration's interpolation stays anchored correctly.
   *
   * Each boundary track position is interpolated from wall-clock elapsed
   * (1ms wall ≈ 1ms of audio at normal speed) and is monotonically clamped
   * into `[previous boundary position, current]`.
   */
  async function splitAtMidnightIfNeeded(itemId: PlaylistItemId, currentPositionMs: number) {
    if (activeSessionId === null) return
    const nowMs = Date.now()
    const nowDay = startOfLocalDay(nowMs)
    // Loop while the session still opened on a calendar day strictly before
    // the day `nowMs` falls on. Each pass peels off exactly one local day.
    // Bounded by elapsed days, and every pass advances `sessionOpenedAtMs` to
    // a strictly-later boundary, so it always terminates.
    while (activeSessionId !== null && startOfLocalDay(sessionOpenedAtMs) < nowDay) {
      // Real local midnight after the session opened — DST-safe (23h/25h days).
      const boundaryMs = startOfNextLocalDay(sessionOpenedAtMs)
      const elapsedMs = boundaryMs - sessionOpenedAtMs
      const boundaryPositionMs = Math.min(
        Math.max(sessionOpenPositionMs + elapsedMs, sessionOpenPositionMs),
        Math.max(currentPositionMs, sessionOpenPositionMs)
      )
      const closing = activeSessionId
      // ended_at = the last whole second of the opening day, so the row is
      // credited to that local day rather than the day we detected the roll.
      await deps.getRepo().finishAt(closing, {
        position: msToSec(boundaryPositionMs),
        endedAtSec: msToSec(boundaryMs) - 1,
      })
      // Continuation starts at the boundary position on the new day, with its
      // open-time pinned to the boundary so the next pass interpolates from
      // there rather than from the detection moment.
      activeSessionId = await deps.getRepo().forceStart({
        itemId,
        position: msToSec(boundaryPositionMs),
      })
      activeItemId = itemId
      noteSessionOpen(boundaryPositionMs, boundaryMs)
    }
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
      // Defensive: caller forgot to close. If that lingering session opened on
      // an earlier local day (the app sat open in the background across one or
      // more midnights before this `start`), split it first so each spanned
      // day keeps its share — otherwise the plain finish below would credit
      // the whole span to today. Use the prior item id: the lingering session
      // belongs to whatever was playing before, not necessarily `itemId`.
      const lingeringItemId = activeItemId
      if (lingeringItemId !== null) await splitAtMidnightIfNeeded(lingeringItemId, positionMs)
      // Close at the current position and open a new one. We don't have the
      // previous tick's position here, so close at `positionMs`.
      try {
        if (activeSessionId !== null) {
          await deps.getRepo().finish(activeSessionId, { position: msToSec(positionMs) })
        }
      } catch {
        // ignore — we'll still open a new session below
      }
    }
    // `forceStart` pins from = position (an explicit discontinuity: seek /
    // midnight-split continuation); `start` inherits from the item's
    // high-water mark so ordinary resume-forward tiles without a gap.
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
      // The write failed (contended DB, disk full) — restore the handle so a
      // later tick/finish can still close this session instead of orphaning
      // it open and losing the interval from the activity totals.
      activeSessionId = id
      activeItemId = itemId
      openItemId = itemId
      throw e
    }
  }

  // ---- public API -----------------------------------------------------------

  async function start({ itemId, positionMs }: { itemId: PlaylistItemId; positionMs: number }) {
    // A session for this item is already open or opening — the periodic tick
    // advances it. This synchronous check (before any await) is what stops the
    // burst-of-progress-events storm.
    if (openItemId === itemId) return
    openItemId = itemId // claim synchronously, before the awaited insert
    try {
      await serialize(() => openRaw(itemId, positionMs, { force: false }))
    } catch (e) {
      // Open failed: release the claim (unless a newer op already moved it) so
      // a later progress event can retry instead of being deduped forever.
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
    // Reflect the SYNCHRONOUS intent (`openItemId`), not just the committed
    // `activeSessionId`. The player reads these to decide start-vs-tick on the
    // next progress event; if they lagged the DB insert, the reentrancy storm
    // this tracker guards against would reappear at the call site.
    hasActiveSession: () => openItemId !== null || activeSessionId !== null,
    activeItemId: () => openItemId ?? activeItemId,
  }
}
