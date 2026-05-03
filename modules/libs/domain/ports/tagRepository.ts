import type { TagId } from "../core.js"
import type { Tag } from "../tag.js"

export interface ITagRepository {
  getById(id: TagId): Promise<Tag | null>
  listAll(): Promise<readonly Tag[]>
}
