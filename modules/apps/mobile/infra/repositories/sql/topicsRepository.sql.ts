import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import type { ITopicRepository, TrackTopicWeight } from "@lib/domain/ports/topicRepository.js"
import type { TopicRow, TrackTopicRow } from "@lib/persistence/main"
import { foldDictRows, rowToTopic } from "./contentRowMappers.js"

export function createSqlTopicRepository(contentDb: IDatabase): ITopicRepository {
  return {
    async getById(id: TopicId): Promise<Topic | null> {
      const rows = await contentDb.query<TopicRow>("SELECT * FROM topics WHERE id = ?", [id])
      if (rows.length === 0) return null
      return rowToTopic(rows)
    },

    async listAll(): Promise<readonly Topic[]> {
      const rows = await contentDb.query<TopicRow>("SELECT * FROM topics ORDER BY id ASC")
      const byId = foldDictRows(rows, rowToTopic)
      return [...byId.values()]
    },

    async weightsForTracks(trackIds: readonly TrackId[]): Promise<readonly TrackTopicWeight[]> {
      if (trackIds.length === 0) return []
      const placeholders = trackIds.map(() => "?").join(", ")
      const rows = await contentDb.query<TrackTopicRow>(
        `SELECT track_id, topic_id, weight FROM track_topics WHERE track_id IN (${placeholders})`,
        [...trackIds]
      )
      return rows.map((r) => ({ trackId: r.track_id, topicId: r.topic_id, weight: r.weight }))
    },

    async topTrackIds(
      topicId: TopicId,
      language: LanguageCode,
      limit: number
    ): Promise<readonly TrackId[]> {
      // Only tracks that actually have a variant in the active UI language, so a
      // topic page never surfaces lectures the user can't read in their language.
      const rows = await contentDb.query<{ track_id: string }>(
        `SELECT tt.track_id
           FROM track_topics tt
           JOIN track_variants tv ON tv.track_id = tt.track_id AND tv.language = ?
          WHERE tt.topic_id = ?
          ORDER BY tt.weight DESC
          LIMIT ?`,
        [language, topicId, limit]
      )
      return rows.map((r) => r.track_id)
    },

    async similarTrackIds(
      topicIds: readonly TopicId[],
      excludeTrackId: TrackId,
      limit: number
    ): Promise<readonly TrackId[]> {
      if (topicIds.length === 0) return []
      const placeholders = topicIds.map(() => "?").join(", ")
      const rows = await contentDb.query<{ track_id: string }>(
        `SELECT track_id
           FROM track_topics
          WHERE topic_id IN (${placeholders}) AND track_id != ?
          GROUP BY track_id
          ORDER BY SUM(weight) DESC
          LIMIT ?`,
        [...topicIds, excludeTrackId, limit]
      )
      return rows.map((r) => r.track_id)
    },
  }
}
