import type { IDatabase } from "@ports/app/index.js"
import type { TopicId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { TopicRow } from "@lib/persistence/main"
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
  }
}
