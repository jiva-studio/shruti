import type { Author } from "../author.js"
import type { AuthorId } from "../core.js"

export interface IAuthorRepository {
  getById(id: AuthorId): Promise<Author | null>
  listAll(): Promise<readonly Author[]>
}
