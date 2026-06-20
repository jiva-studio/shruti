import type { IDatabase } from "@ports/app/index.js"
import type { IKeyValueRepository } from "@lib/domain/ports/keyValueRepository.js"
import type { KeyValueRow } from "@lib/persistence/main"

export function createSqlKeyValueRepository(contentDb: IDatabase): IKeyValueRepository {
  return {
    async get(key: string): Promise<string | null> {
      try {
        const rows = await contentDb.query<KeyValueRow>(
          "SELECT value FROM key_value WHERE key = ?",
          [key]
        )
        return rows.length > 0 ? rows[0].value : null
      } catch {
        // Older bundled/cached DBs predate the key_value table — treat as unset
        // so callers fall back gracefully (no missing-table crash).
        return null
      }
    },
  }
}
