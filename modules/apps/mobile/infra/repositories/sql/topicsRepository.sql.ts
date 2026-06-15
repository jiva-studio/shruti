import type { IDatabase } from "@ports/app/index.js"
import type { TopicId, TrackId } from "@lib/domain/core.js"
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

    async topTrackIds(topicId: TopicId, limit: number): Promise<readonly TrackId[]> {
      const rows = await contentDb.query<{ track_id: string }>(
        "SELECT track_id FROM track_topics WHERE topic_id = ? ORDER BY weight DESC LIMIT ?",
        [topicId, limit]
      )
      return rows.map((r) => r.track_id)
    },
  }
}
