import type { IDatabase } from "@ports/app/index.js"
import type { TagId } from "@lib/domain/core.js"
import type { Tag } from "@lib/domain/tag.js"
import type { ITagRepository } from "@lib/domain/ports/tagRepository.js"
import type { TagNameRow } from "@lib/persistence/main"
import { rowToTag } from "./contentRowMappers.js"

export function createSqlTagRepository(contentDb: IDatabase): ITagRepository {
  return {
    async getById(id: TagId): Promise<Tag | null> {
      const rows = await contentDb.query<{ id: string }>("SELECT id FROM tags WHERE id = ?", [id])
      if (rows.length === 0) return null
      const names = await contentDb.query<TagNameRow>(
        "SELECT * FROM tag_names WHERE tag_id = ?",
        [id]
      )
      return rowToTag(rows[0], names)
    },

    async listAll(): Promise<readonly Tag[]> {
      const [ids, names] = await Promise.all([
        contentDb.query<{ id: string }>("SELECT id FROM tags ORDER BY id ASC"),
        contentDb.query<TagNameRow>("SELECT * FROM tag_names"),
      ])
      return ids.map((row) => rowToTag(row, names))
    },
  }
}
