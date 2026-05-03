import type { IDatabase } from "@ports/app/index.js"
import type { TagId } from "@lib/domain/core.js"
import type { Tag } from "@lib/domain/tag.js"
import type { ITagRepository } from "@lib/domain/ports/tagRepository.js"
import type { TagRow } from "@lib/persistence/main"
import { foldDictRows, rowToTag } from "./contentRowMappers.js"

export function createSqlTagRepository(contentDb: IDatabase): ITagRepository {
  return {
    async getById(id: TagId): Promise<Tag | null> {
      const rows = await contentDb.query<TagRow>("SELECT * FROM tags WHERE id = ?", [id])
      if (rows.length === 0) return null
      return rowToTag(rows)
    },

    async listAll(): Promise<readonly Tag[]> {
      const rows = await contentDb.query<TagRow>("SELECT * FROM tags ORDER BY id ASC")
      const byId = foldDictRows(rows, rowToTag)
      return [...byId.values()]
    },
  }
}
