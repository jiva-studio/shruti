import type { IDatabase } from "@ports/app/index.js"
import type { SourceId } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { ISourceRepository } from "@lib/domain/ports/sourceRepository.js"
import type { SourceRow } from "@lib/persistence/main"
import { foldDictRows, rowToSource } from "./contentRowMappers.js"

export function createSqlSourceRepository(contentDb: IDatabase): ISourceRepository {
  return {
    async getById(id: SourceId): Promise<Source | null> {
      const rows = await contentDb.query<SourceRow>("SELECT * FROM sources WHERE id = ?", [id])
      if (rows.length === 0) return null
      return rowToSource(rows)
    },

    async listAll(): Promise<readonly Source[]> {
      const rows = await contentDb.query<SourceRow>("SELECT * FROM sources ORDER BY id ASC")
      const byId = foldDictRows(rows, rowToSource)
      return [...byId.values()]
    },
  }
}
