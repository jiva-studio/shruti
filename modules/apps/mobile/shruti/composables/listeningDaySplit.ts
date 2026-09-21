import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 1000)
}

/** Local-midnight (00:00:00.000) of the calendar day that `ms` falls on. */
export function startOfLocalDay(ms: number): number {
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

export interface SessionCursor {
  readonly sessionId: ListeningSessionId
  readonly itemId: PlaylistItemId
  /** Wall clock at which this row opened — the boundary for a continuation,
   *  not the moment the roll was detected. */
  readonly openedAtMs: number
  readonly openPositionMs: number
}

/**
 * Track position at the local midnight following `openedAtMs`, interpolated
 * from wall-clock elapsed (1ms wall is 1ms of audio at normal speed) and
 * clamped into `[open position, current]`. `null` when the session opened on
 * the same local day as `nowMs`.
 */
export function midnightSlice(
  cursor: Pick<SessionCursor, "openedAtMs" | "openPositionMs">,
  currentPositionMs: number,
  nowMs: number
): { boundaryMs: number; boundaryPositionMs: number } | null {
  if (startOfLocalDay(cursor.openedAtMs) >= startOfLocalDay(nowMs)) return null
  const boundaryMs = startOfNextLocalDay(cursor.openedAtMs)
  const elapsedMs = boundaryMs - cursor.openedAtMs
  const boundaryPositionMs = Math.min(
    Math.max(cursor.openPositionMs + elapsedMs, cursor.openPositionMs),
    Math.max(currentPositionMs, cursor.openPositionMs)
  )
  return { boundaryMs, boundaryPositionMs }
}

/**
 * Close a session that spans one or more local midnights at the last second of
 * each day it crossed, reopening a continuation for the next one, and return
 * the cursor of the row left open. `getDailyTotals` groups by
 * `date(ended_at, 'localtime')`, so an unsplit session would credit its whole
 * span to the day it ended on and leave every intervening day at zero.
 */
export async function splitSessionAtMidnights(
  repo: IListeningSessionRepository,
  cursor: SessionCursor,
  currentPositionMs: number,
  nowMs: number = Date.now()
): Promise<SessionCursor> {
  let current = cursor
  // Every pass advances `openedAtMs` to a strictly later boundary, so this
  // terminates after one iteration per spanned day.
  for (;;) {
    const slice = midnightSlice(current, currentPositionMs, nowMs)
    if (slice === null) return current
    await repo.finishAt(current.sessionId, {
      position: msToSec(slice.boundaryPositionMs),
      endedAtSec: msToSec(slice.boundaryMs) - 1,
    })
    const sessionId = await repo.forceStart({
      itemId: current.itemId,
      position: msToSec(slice.boundaryPositionMs),
    })
    current = {
      sessionId,
      itemId: current.itemId,
      openedAtMs: slice.boundaryMs,
      openPositionMs: Math.max(0, slice.boundaryPositionMs),
    }
  }
}
