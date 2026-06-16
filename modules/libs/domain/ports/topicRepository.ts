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
  /** Track ids carrying a topic that have a variant in `language`, highest
   *  weight first (the topic shelf / topic page in the active UI language). */
  topTrackIds(
    topicId: TopicId,
    language: LanguageCode,
    limit: number
  ): Promise<readonly TrackId[]>
  /** Tracks most similar to a seed by topic overlap (scored by the neighbour's
   *  summed weight on the shared topics), excluding the seed. Highest first. */
  similarTrackIds(
    topicIds: readonly TopicId[],
    excludeTrackId: TrackId,
    limit: number
  ): Promise<readonly TrackId[]>
}
