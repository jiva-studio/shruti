/**
 * The one answer to "is this transcript block part of that time range" —
 * shared by the live drag-selection highlight, the text payload the popover
 * acts on, and the saved-note underline rebuilt by `buildTranscriptViewData`.
 *
 * There used to be two spellings of it: containment while dragging, inclusive
 * overlap after saving. Sentence blocks in this corpus are commonly contiguous
 * (`end_i === start_{i+1}`), so the inclusive one matched three blocks for a
 * one-sentence bookmark the moment it was saved (issue #1731). Ranges are
 * therefore treated as HALF-OPEN — `[start, end)` — so intervals that merely
 * touch at an endpoint do not intersect.
 */

export interface UiTimeRange {
  readonly start: number
  readonly end: number
}

/** A zero-length interval is a point; a point belongs to any interval that
 *  covers it, endpoints included. */
function covers(range: UiTimeRange, point: number): boolean {
  return range.start <= point && point <= range.end
}

/**
 * True when `a` and `b` share more than a boundary.
 *
 * Zero-length intervals are real on both sides and are handled explicitly:
 * verse blocks carry `start === end` (72 of the 394 blocks in the e2e fixture),
 * and a note range may be zero-length too — `validateNoteFields` only rejects
 * `timeEnd < timeStart`, so bookmarking such a block writes a point note. The
 * half-open test alone would never match either, silently dropping every verse
 * chip from selections and underlines, so a point falls back to closed
 * containment in the other interval, and two points intersect when equal.
 */
export function timeRangesIntersect(a: UiTimeRange, b: UiTimeRange): boolean {
  const aIsPoint = a.start >= a.end
  const bIsPoint = b.start >= b.end
  if (aIsPoint && bIsPoint) return a.start === b.start
  if (aIsPoint) return covers(b, a.start)
  if (bIsPoint) return covers(a, b.start)
  return a.start < b.end && b.start < a.end
}
