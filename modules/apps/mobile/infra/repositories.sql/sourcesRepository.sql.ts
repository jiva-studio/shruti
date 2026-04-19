import type { IDatabase } from "@ports/app/index.js"
import type { SourceId } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { ISourceRepository } from "@lib/domain/ports/sourceRepository.js"
import type { SourceNameRow } from "@lib/persistence/main"
import { rowToSource } from "./contentRowMappers.js"

export function createSqlSourceRepository(contentDb: IDatabase): ISourceRepository {
  return {
    async getById(id: SourceId): Promise<Source | null> {
      const rows = await contentDb.query<{ id: string }>("SELECT id FROM sources WHERE id = ?", [
        id,
      ])
      if (rows.length === 0) return null
      const names = await contentDb.query<SourceNameRow>(
        "SELECT * FROM source_names WHERE source_id = ?",
        [id]
      )
      return rowToSource(rows[0], names)
    },

    async listAll(): Promise<readonly Source[]> {
      const [ids, names] = await Promise.all([
        contentDb.query<{ id: string }>("SELECT id FROM sources ORDER BY id ASC"),
        contentDb.query<SourceNameRow>("SELECT * FROM source_names"),
      ])
      return ids.map((row) => rowToSource(row, names))
    },
  }
}
