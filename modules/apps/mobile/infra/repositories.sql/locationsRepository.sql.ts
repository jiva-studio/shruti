import type { IDatabase } from "@ports/app/index.js"
import type { LocationId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { ILocationRepository } from "@lib/domain/ports/locationRepository.js"
import type { LocationNameRow } from "@lib/persistence/main"
import { rowToLocation } from "./contentRowMappers.js"

export function createSqlLocationRepository(contentDb: IDatabase): ILocationRepository {
  return {
    async getById(id: LocationId): Promise<Location | null> {
      const rows = await contentDb.query<{ id: string }>("SELECT id FROM locations WHERE id = ?", [
        id,
      ])
      if (rows.length === 0) return null
      const names = await contentDb.query<LocationNameRow>(
        "SELECT * FROM location_names WHERE location_id = ?",
        [id]
      )
      return rowToLocation(rows[0], names)
    },

    async listAll(): Promise<readonly Location[]> {
      const [ids, names] = await Promise.all([
        contentDb.query<{ id: string }>("SELECT id FROM locations ORDER BY id ASC"),
        contentDb.query<LocationNameRow>("SELECT * FROM location_names"),
      ])
      return ids.map((row) => rowToLocation(row, names))
    },
  }
}
