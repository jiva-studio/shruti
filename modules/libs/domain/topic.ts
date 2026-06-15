import type { LanguageCode, TopicId } from "./core.js"

/**
 * Topic — one canonical recommender theme (the dictionary side, mirrors Tag).
 * Localisation lives in `names`; a track's membership + weight lives separately
 * in `track_topics` (see Track.topicIds, ordered by weight).
 */
export interface Topic {
  readonly id: TopicId
  readonly names: ReadonlyMap<LanguageCode, string>
}
