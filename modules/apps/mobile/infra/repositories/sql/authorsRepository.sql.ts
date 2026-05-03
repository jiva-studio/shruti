import type { IDatabase } from "@ports/app/index.js"
import type { AuthorId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { AuthorRow } from "@lib/persistence/main"
import { foldDictRows, rowToAuthor } from "./contentRowMappers.js"

export function createSqlAuthorRepository(contentDb: IDatabase): IAuthorRepository {
  return {
    async getById(id: AuthorId): Promise<Author | null> {
      const rows = await contentDb.query<AuthorRow>("SELECT * FROM authors WHERE id = ?", [id])
      if (rows.length === 0) return null
      return rowToAuthor(rows)
    },

    async listAll(): Promise<readonly Author[]> {
      const rows = await contentDb.query<AuthorRow>("SELECT * FROM authors ORDER BY id ASC")
      const byId = foldDictRows(rows, rowToAuthor)
      return [...byId.values()]
    },
  }
}
