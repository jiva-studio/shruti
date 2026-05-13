import type { PlaylistItemId } from "./core.js"

export type ListeningSessionId = string

/** Unix time in seconds. */
export type UnixSec = number

/** Position in a track, expressed in seconds from the start. */
export type TrackPositionSec = number

/**
 * One row of the listening journal. Covers a single play→pause/seek/
 * track-change interval. `started_at` and `ended_at` are unix seconds;
 * `from_position` / `to_position` are seconds from the start of the
 * track. Duration listened during the session = `to_position - from_position`.
 */
export interface ListeningSession {
  readonly id: ListeningSessionId
  readonly itemId: PlaylistItemId
  readonly startedAt: UnixSec
  readonly endedAt: UnixSec
  readonly fromPosition: TrackPositionSec
  readonly toPosition: TrackPositionSec
}

/** Total seconds listened on a single calendar day (local timezone). */
export interface DailyListeningTotal {
  /** ISO date "YYYY-MM-DD" in local timezone. */
  readonly date: string
  readonly listenedSeconds: number
}

/**
 * Distance from the end of a track within which we consider the track
 * "completed" — used both for "mark as listened" semantics in the
 * playlist and for "restart from 0 on next resume" in the player.
 *
 * Two seconds is a fingerprint, not a guess: it matches the engine's
 * post-pause settle time, after which a "play to end" leaves the
 * reported position slightly short of duration.
 */
export const COMPLETION_THRESHOLD_MS = 2000

/** Same threshold in whole seconds — the SQL adapter stores positions in seconds. */
export const COMPLETION_THRESHOLD_SEC = COMPLETION_THRESHOLD_MS / 1000

/**
 * True when the listened position is at or within the completion
 * threshold of the duration. Returns false when duration is unknown
 * (≤ 0) so the rule never marks "no-duration" tracks as completed.
 *
 * `positionMs` and `durationMs` must be in the same unit; pass either
 * milliseconds (the engine's native unit) or use {@link isCompletedSec}
 * for the seconds-based SQL paths.
 */
export function isCompleted(positionMs: number, durationMs: number): boolean {
  if (durationMs <= 0) return false
  return positionMs >= durationMs - COMPLETION_THRESHOLD_MS
}

/** Seconds-based companion to {@link isCompleted}. */
export function isCompletedSec(positionSec: number, durationSec: number): boolean {
  if (durationSec <= 0) return false
  return positionSec >= durationSec - COMPLETION_THRESHOLD_SEC
}
