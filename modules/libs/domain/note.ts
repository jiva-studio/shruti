import type { NoteId, TrackId, UnixMs } from "./core.js"

/**
 * Free-form JSON sidecar persisted alongside the note. The shape is
 * intentionally open so feature code can append its own slot without a
 * schema migration — the only convention is "use a top-level key for
 * your feature" (e.g. `meta.studio`).
 */
export type NoteMeta = Record<string, unknown>

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
  /**
   * Optional feature-owned sidecar. `null` (not `undefined`) means the
   * row exists but has no meta yet — `undefined` only appears in inputs
   * meaning "don't touch the column on update".
   */
  readonly meta: NoteMeta | null
}
