import type { AuthorId, IsoDate, LocationId, TrackId, TagId, TopicId } from "./core.js"
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
  /** Raw author/location labels for a personal-library track whose metadata
   *  isn't a corpus entity (author/location ids null). Absent for corpus tracks;
   *  resolvers fall back to these when the id doesn't resolve. */
  readonly authorRaw?: string | null
  readonly locationRaw?: string | null
  readonly date: IsoDate
  readonly hidden: boolean
  readonly references: readonly Reference[]
  readonly tagIds: readonly TagId[]
  /** Canonical recommender topics, ordered by descending weight. */
  readonly topicIds: readonly TopicId[]
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

/**
 * Pick a variant that has playable audio without considering language.
 * Prefer the "original" recording, then fall back to any variant whose
 * audio is non-null; returns `null` when the track is translation-only
 * (no audio anywhere).
 *
 * Use this for surfaces that don't have a preferred-language signal —
 * share/excerpt flows, citation snippets, post-search "play first
 * audio I can find" affordances. The lecture player itself uses
 * `pickVariantWithAudio(track, preferredLanguage)` from `playTrack` to
 * respect the user's language preference; that is a separate concern.
 */
export function pickPlayableVariant(track: Track): TrackVariant | null {
  // `variant.audio` is already the preferred version (clean over original),
  // so any variant with audio is playable.
  return track.variants.find((v) => v.audio !== null) ?? null
}
