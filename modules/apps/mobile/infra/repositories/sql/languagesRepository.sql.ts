import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Language } from "@lib/domain/language.js"
import type { ILanguageRepository } from "@lib/domain/ports/languageRepository.js"
import type { LanguageRow } from "@lib/persistence/main"
import { queryMany, queryOne } from "@kit/persistence"
import { rowToLanguage } from "./contentRowMappers.js"

export function createSqlLanguageRepository(contentDb: IDatabase): ILanguageRepository {
  return {
    async getByCode(code: LanguageCode): Promise<Language | null> {
      return queryOne<LanguageRow, Language>(
        contentDb,
        "SELECT * FROM languages WHERE code = ?",
        [code],
        rowToLanguage
      )
    },

    async listAll(): Promise<readonly Language[]> {
      return queryMany<LanguageRow, Language>(
        contentDb,
        "SELECT * FROM languages ORDER BY code ASC",
        [],
        rowToLanguage
      )
    },

    async listWithTracks(): Promise<readonly Language[]> {
      return queryMany<LanguageRow, Language>(
        contentDb,
        `SELECT DISTINCT l.* FROM languages l
           JOIN track_variants v ON l.code = v.language
          WHERE EXISTS (
            SELECT 1 FROM tracks t WHERE t.id = v.track_id AND t.hidden = 0
          )
          ORDER BY l.code ASC`,
        [],
        rowToLanguage
      )
    },
  }
}
