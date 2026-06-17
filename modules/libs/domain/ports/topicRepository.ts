import type { LanguageCode, TopicId, TrackId } from "../core.js"
import type { Topic } from "../topic.js"

/** One (track, topic) membership weight — the on-device taste-profile input. */
export interface TrackTopicWeight {
  readonly trackId: TrackId
  readonly topicId: TopicId
  readonly weight: number
}

export interface ITopicRepository {
  getById(id: TopicId): Promise<Topic | null>
  listAll(): Promise<readonly Topic[]>
  /** (topic, weight) rows for the given tracks — feeds the taste profile. */
  weightsForTracks(trackIds: readonly TrackId[]): Promise<readonly TrackTopicWeight[]>
  /** Track ids carrying a topic that have a variant in one of `languages`,
   *  highest weight first (the topic shelf / topic page filtered to the user's
   *  library languages). Empty `languages` = no language filter (all tracks). */
  topTrackIds(
    topicId: TopicId,
    languages: readonly LanguageCode[],
    limit: number
  ): Promise<readonly TrackId[]>
  /** Topic ids that have at least one track with a variant in one of
   *  `languages` — used to drop topics with no lectures in the user's library
   *  languages from discovery surfaces. Empty `languages` = every used topic. */
  topicIdsWithTracksIn(languages: readonly LanguageCode[]): Promise<readonly TopicId[]>
  /** Tracks most similar to a seed by topic overlap (scored by the neighbour's
   *  summed weight on the shared topics), excluding the seed, restricted to
   *  neighbours with a variant in one of `languages` (empty = no filter).
   *  Highest first. */
  similarTrackIds(
    topicIds: readonly TopicId[],
    excludeTrackId: TrackId,
    languages: readonly LanguageCode[],
    limit: number
  ): Promise<readonly TrackId[]>
}
