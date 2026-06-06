import type { NoteId, TrackId, UnixMs } from "./core.js"
import { err, ok, type Result } from "./result.js"

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

/** Maximum length for a note's `text`, enforced by the domain. */
export const MAX_NOTE_LENGTH = 4000

/**
 * Validation errors emitted by {@link validateNoteFields}. Fine-grained
 * so the create/update use cases can map them to their own error unions
 * (e.g. createNote folds time-shape into a single `invalid-timestamps`
 * umbrella) without losing information at the validator boundary.
 */
export type NoteValidationError =
  | "empty-text"
  | "text-too-long"
  | "invalid-time"
  | "invalid-range"

export interface NoteFields {
  readonly text: string
  /** milliseconds — see `Note.timeStart` */
  readonly timeStart: number
  /** milliseconds — see `Note.timeEnd` */
  readonly timeEnd: number
}

/**
 * Validate the user-supplied field set for a note (used by both create
 * and update; update calls it on the *merged* existing+patch values).
 * On success returns the normalised fields — notably `text` is trimmed
 * so callers don't have to re-trim before writing.
 *
 * The invariants live on the entity, not in the use case, because they
 * apply to every code path that produces a `Note`: today create +
 * update; tomorrow an "import notes" flow shouldn't have to know the
 * length cap to stay correct.
 */
export function validateNoteFields(
  input: NoteFields
): Result<NoteFields, NoteValidationError> {
  const text = input.text.trim()
  if (!text) return err("empty-text")
  if (text.length > MAX_NOTE_LENGTH) return err("text-too-long")
  // NaN / ±Infinity pass through `<` / `<=` as false, so the range
  // check would silently accept garbage; reject explicitly first.
  if (!Number.isFinite(input.timeStart) || !Number.isFinite(input.timeEnd)) {
    return err("invalid-time")
  }
  if (input.timeStart < 0) return err("invalid-range")
  if (input.timeEnd < input.timeStart) return err("invalid-range")
  return ok({ text, timeStart: input.timeStart, timeEnd: input.timeEnd })
}
