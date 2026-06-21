import type { IDatabase } from "@ports/app/index.js"
import type { ISettingsRepository } from "@lib/domain/ports/settingsRepository.js"
import type { SettingsRow } from "@lib/persistence/main"

export function createSqlSettingsRepository(contentDb: IDatabase): ISettingsRepository {
  return {
    async get(key: string): Promise<string | null> {
      try {
        const rows = await contentDb.query<SettingsRow>(
          "SELECT value FROM settings WHERE key = ?",
          [key]
        )
        return rows.length > 0 ? rows[0].value : null
      } catch {
        // Older bundled/cached DBs predate the settings table — treat as unset
        // so callers fall back gracefully (no missing-table crash).
        return null
      }
    },
  }
}
