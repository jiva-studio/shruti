import type { IDatabase, ISchemeVersionRepository } from "@ports/app/index.js"

/**
 * Reads the content DB scheme by inspecting its `migrations` table. Pre-
 * scheme databases (and any DB missing the `migrations` table or a
 * scheme-marked row) report `0`, which the caller treats as "unknown /
 * legacy" and accepts.
 *
 * The legacy-`0` fallback is dangerous on its own: a truncated or corrupt
 * DB also fails the `migrations` query, so it would masquerade as a valid
 * legacy DB and pass scheme validation. To tell a genuine legacy DB apart
 * from a corrupt one, the `0` fallback is gated behind a positive probe of
 * a core table (`tracks`). If that probe also fails, the DB is unreadable
 * and we surface the error instead of returning `0`.
 */
export function createSqlSchemeVersionRepository(db: IDatabase): ISchemeVersionRepository {
  return {
    async read(): Promise<number> {
      let schemeQueryFailed = false
      try {
        const rows = await db.query<{ scheme: number }>(
          "SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1"
        )
        if (rows[0]?.scheme != null) return rows[0].scheme
      } catch {
        schemeQueryFailed = true
      }

      // No scheme row (or the migrations table is missing): only accept the
      // legacy `0` once we've confirmed the DB is actually readable. A probe
      // against a core table separates a real pre-scheme DB from a corrupt /
      // truncated file masquerading as one.
      try {
        await db.query("SELECT count(*) FROM tracks")
      } catch (err) {
        throw new Error(
          "Content database is unreadable: the migrations scheme query " +
            `${schemeQueryFailed ? "failed" : "returned no row"} and the ` +
            "tracks integrity probe failed",
          { cause: err }
        )
      }

      return 0
    },
  }
}
