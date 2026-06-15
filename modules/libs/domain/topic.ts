import type { LanguageCode, TopicId } from "./core.js"

/**
 * Topic — one canonical recommender theme (the dictionary side, mirrors Tag).
 * Localisation lives in `names` (full) and `shortNames` (a tighter label for
 * chips / shelf headers, may be absent for a locale); `cover` is a generated,
 * language-neutral cover image key. A track's membership + weight lives
 * separately in `track_topics` (see Track.topicIds, ordered by weight).
 */
export interface Topic {
  readonly id: TopicId
  readonly names: ReadonlyMap<LanguageCode, string>
  readonly shortNames: ReadonlyMap<LanguageCode, string>
  readonly cover: string | null
}
