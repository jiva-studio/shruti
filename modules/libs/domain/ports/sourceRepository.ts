import type { SourceId } from "../core.js"
import type { Source } from "../source.js"

export interface ISourceRepository {
  getById(id: SourceId): Promise<Source | null>
  listAll(): Promise<readonly Source[]>
}
