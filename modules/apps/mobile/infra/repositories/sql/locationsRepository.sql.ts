import type { IDatabase } from "@ports/app/index.js"
import type { LocationId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { ILocationRepository } from "@lib/domain/ports/locationRepository.js"
import type { LocationRow } from "@lib/persistence/main"
import { foldDictRows, rowToLocation } from "./contentRowMappers.js"

export function createSqlLocationRepository(contentDb: IDatabase): ILocationRepository {
  return {
    async getById(id: LocationId): Promise<Location | null> {
      const rows = await contentDb.query<LocationRow>(
        "SELECT * FROM locations WHERE id = ?",
        [id]
      )
      if (rows.length === 0) return null
      return rowToLocation(rows)
    },

    async listAll(): Promise<readonly Location[]> {
      const rows = await contentDb.query<LocationRow>(
        "SELECT * FROM locations ORDER BY id ASC"
      )
      const byId = foldDictRows(rows, rowToLocation)
      return [...byId.values()]
    },
  }
}
