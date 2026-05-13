import type { AuthorId, IsoDate, LocationId, TrackId, TagId } from "./core.js"
import type { Reference } from "./reference.js"
import type { TrackVariant } from "./trackVariant.js"

/**
 * Track — a single lecture recording. Language-independent metadata lives
 * here; per-language titles / audio / transcript paths live in TrackVariant.
 */
export interface Track {
  readonly id: TrackId
  /** nullable — legacy recordings may have unknown author */
  readonly authorId: AuthorId | null
  /** nullable — legacy recordings may have unknown location */
  readonly locationId: LocationId | null
  readonly date: IsoDate
  readonly hidden: boolean
  readonly references: readonly Reference[]
  readonly tagIds: readonly TagId[]
  readonly variants: readonly TrackVariant[]
}

/**
 * Longest audio variant's duration, in milliseconds, as a representative
 * length for the track.
 *
 * The player picks a variant by `preferredLanguage` and writes positions
 * against its duration; using the first variant in the UI can produce
 * percentages above 100 % when that variant is shorter than the one the
 * user actually played. Taking the MAX keeps the denominator >= any
 * saved progress, at the cost of a slight under-estimate for users who
 * stuck to the shorter variant.
 */
export function maxAudioDurationMs(track: Track): number {
  let max = 0
  for (const v of track.variants) {
    if (v.audio?.duration && v.audio.duration > max) max = v.audio.duration
  }
  return max
}
