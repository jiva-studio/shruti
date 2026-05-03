import type { IDatabase, ISchemeVersionRepository } from "@ports/app/index.js"

/**
 * Reads the content DB scheme by inspecting its `migrations` table. Pre-
 * scheme databases (and any DB missing the `migrations` table or a
 * scheme-marked row) report `0`, which the caller treats as "unknown /
 * legacy" and accepts.
 */
export function createSqlSchemeVersionRepository(db: IDatabase): ISchemeVersionRepository {
  return {
    async read(): Promise<number> {
      try {
        const rows = await db.query<{ scheme: number }>(
          "SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1"
        )
        return rows[0]?.scheme ?? 0
      } catch {
        return 0
      }
    },
  }
}
