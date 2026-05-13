import type { NoteId, TrackId, UnixMs } from "./core.js"

export interface Note {
  readonly id: NoteId
  readonly trackId: TrackId
  readonly text: string
  /**
   * Start time within the track, in **milliseconds** — same unit as the
   * transcript blocks' `start`/`end`. The drag-selection reads
   * `data-time-start` directly off the rendered blocks, so the value
   * stays in ms end-to-end (DB column `time_start` is just `INTEGER`).
   */
  readonly timeStart: number
  /** End time within the track, in **milliseconds**. */
  readonly timeEnd: number
  readonly createdAt: UnixMs
}
