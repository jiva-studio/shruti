import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Language } from "@lib/domain/language.js"
import type { ILanguageRepository } from "@lib/domain/ports/languageRepository.js"
import type { LanguageRow } from "@lib/persistence/main"
import { rowToLanguage } from "./contentRowMappers.js"

export function createSqlLanguageRepository(contentDb: IDatabase): ILanguageRepository {
  return {
    async getByCode(code: LanguageCode): Promise<Language | null> {
      const rows = await contentDb.query<LanguageRow>(
        "SELECT * FROM languages WHERE code = ?",
        [code]
      )
      return rows[0] ? rowToLanguage(rows[0]) : null
    },

    async listAll(): Promise<readonly Language[]> {
      const rows = await contentDb.query<LanguageRow>(
        "SELECT * FROM languages ORDER BY code ASC"
      )
      return rows.map(rowToLanguage)
    },
  }
}
