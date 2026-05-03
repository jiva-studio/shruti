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
