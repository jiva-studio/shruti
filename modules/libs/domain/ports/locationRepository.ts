import type { LocationId } from "../core.js"
import type { Location } from "../location.js"

export interface ILocationRepository {
  getById(id: LocationId): Promise<Location | null>
  listAll(): Promise<readonly Location[]>
}
