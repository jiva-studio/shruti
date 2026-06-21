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
    async byId(id: string): Promise<DailyWisdom | null> {
      try {
        const rows = await contentDb.query<DailyWisdomRow>(
          "SELECT * FROM daily_wisdom WHERE id = ?",
          [id]
        )
        return rows.length > 0 ? rowToWisdom(rows[0]) : null
      } catch {
        return null
      }
    },

    async list(language?: LanguageCode): Promise<readonly DailyWisdom[]> {
      try {
        const rows = language
          ? await contentDb.query<DailyWisdomRow>("SELECT * FROM daily_wisdom WHERE language = ?", [
              language,
            ])
          : await contentDb.query<DailyWisdomRow>("SELECT * FROM daily_wisdom")
        return rows.map(rowToWisdom)
      } catch {
        return []
      }
    },
  }
}
