import type { IDatabase } from "@ports/app/index.js"

/**
 * Featured-pack header row, as returned by the catalog DB.
 *
 * `name` is the chip label the user sees (e.g. "Лекции о карме и
 * судьбе" / "Lectures on karma and destiny"). `sort_order` is an ASC
 * display key — the repo already orders by it, so consumers can pass
 * the list straight to the UI.
 */
export interface FeaturedPackRow {
  readonly id: string
  readonly name: string
  readonly sort_order: number
}

export interface ISqlPackRepository {
  /**
   * Featured packs for `locale`, ordered by `sort_order ASC` then `id ASC`.
   * Returns an empty array (not throws) when the catalog DB has no
   * `packs` table — that happens on fresh installs whose bundled
   * `current.db` predates the starter-packs schema rollout. The Home
   * view degrades to its pre-packs empty-state in that case.
   */
  listFeaturedPacks(locale: string): Promise<readonly FeaturedPackRow[]>

  /**
   * Ordered list of track ids for one pack locale. Empty array when the
   * pack has no members yet, or when the table is missing (see
   * `listFeaturedPacks`). Order is `position ASC`.
   */
  getPackTrackIds(packId: string, locale: string): Promise<readonly string[]>
}

/**
 * Capacitor-SQLite-backed read-only repository for starter packs. The
 * publisher of `current.db` owns the table schema; this repo only
 * reads.
 *
 * We treat `no such table: packs` as "no packs available" rather than
 * an error: a freshly-shipped mobile binary against an older bundled
 * DB stays usable. Any other SQL error is rethrown so legitimate bugs
 * surface in logs.
 */
export function createSqlPackRepository(contentDb: IDatabase): ISqlPackRepository {
  return {
    async listFeaturedPacks(locale: string): Promise<readonly FeaturedPackRow[]> {
      try {
        const rows = await contentDb.query<FeaturedPackRow>(
          `SELECT id, name, sort_order
             FROM packs
            WHERE language = ? AND featured = 1
            ORDER BY sort_order ASC, id ASC`,
          [locale]
        )
        return rows
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getPackTrackIds(packId: string, locale: string): Promise<readonly string[]> {
      try {
        const rows = await contentDb.query<{ track_id: string }>(
          `SELECT track_id
             FROM pack_tracks
            WHERE pack_id = ? AND pack_language = ?
            ORDER BY position ASC, track_id ASC`,
          [packId, locale]
        )
        return rows.map((r) => r.track_id)
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },
  }
}

/**
 * SQLite returns `no such table: <name>` when a query hits a table
 * that hasn't been created. We surface that as "no packs" so the
 * mobile binary can ship ahead of the catalog schema.
 *
 * Both `sql.js` (web) and `@capacitor-community/sqlite` (native)
 * include the table name in the message, so a substring match is
 * sufficient.
 */
function isMissingTable(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*(packs|pack_tracks)\b/i.test(message)
}
