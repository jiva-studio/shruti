import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { DailyWisdom } from "@lib/domain/dailyWisdom.js"
import type { IDailyWisdomRepository } from "@lib/domain/ports/dailyWisdomRepository.js"
import type { DailyWisdomRow } from "@lib/persistence/main"

function rowToWisdom(r: DailyWisdomRow): DailyWisdom {
  return {
    id: r.id,
    trackId: r.track_id,
    language: r.language as LanguageCode,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    topicId: r.topic_id as TopicId,
  }
}

export function createSqlDailyWisdomRepository(contentDb: IDatabase): IDailyWisdomRepository {
  return {
    async byTopic(topicId: TopicId, language: LanguageCode): Promise<readonly DailyWisdom[]> {
      try {
        const rows = await contentDb.query<DailyWisdomRow>(
          "SELECT * FROM daily_wisdom WHERE topic_id = ? AND language = ?",
          [topicId, language]
        )
        return rows.map(rowToWisdom)
      } catch {
        return []
      }
    },

    async topicsWithWisdom(
      topicIds: readonly TopicId[],
      language: LanguageCode
    ): Promise<readonly TopicId[]> {
      if (topicIds.length === 0) return []
      try {
        const placeholders = topicIds.map(() => "?").join(", ")
        const rows = await contentDb.query<{ topic_id: string }>(
          `SELECT DISTINCT topic_id FROM daily_wisdom
            WHERE language = ? AND topic_id IN (${placeholders})`,
          [language, ...topicIds]
        )
        return rows.map((r) => r.topic_id as TopicId)
      } catch {
        return []
      }
    },
  }
}
