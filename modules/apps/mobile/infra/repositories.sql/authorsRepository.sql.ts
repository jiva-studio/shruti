import type { IDatabase } from "@ports/app/index.js"
import type { AuthorId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { AuthorNameRow } from "@lib/persistence/main"
import { rowToAuthor } from "./contentRowMappers.js"

export function createSqlAuthorRepository(contentDb: IDatabase): IAuthorRepository {
  return {
    async getById(id: AuthorId): Promise<Author | null> {
      const rows = await contentDb.query<{ id: string }>("SELECT id FROM authors WHERE id = ?", [
        id,
      ])
      if (rows.length === 0) return null
      const names = await contentDb.query<AuthorNameRow>(
        "SELECT * FROM author_names WHERE author_id = ?",
        [id]
      )
      return rowToAuthor(rows[0], names)
    },

    async listAll(): Promise<readonly Author[]> {
      const [ids, names] = await Promise.all([
        contentDb.query<{ id: string }>("SELECT id FROM authors ORDER BY id ASC"),
        contentDb.query<AuthorNameRow>("SELECT * FROM author_names"),
      ])
      return ids.map((row) => rowToAuthor(row, names))
    },
  }
}
