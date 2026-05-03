import type { NoteId, TrackId, UnixMs } from "./core.js"

export interface Note {
  readonly id: NoteId
  readonly trackId: TrackId
  readonly text: string
  /** Start time within the track, in seconds. */
  readonly timeStart: number
  /** End time within the track, in seconds. */
  readonly timeEnd: number
  readonly createdAt: UnixMs
}
