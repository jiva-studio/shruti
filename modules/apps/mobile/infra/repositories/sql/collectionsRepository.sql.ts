import type { IDatabase } from "@ports/app/index.js"

/**
 * Featured-collection header row, as returned by the catalog DB.
 *
 * `name` is the label the user sees (e.g. "Лекции о карме и судьбе" /
 * "Lectures on karma and destiny"). `sort_order` is an ASC display key —
 * the repo already orders by it, so consumers can pass the list straight
 * to the UI.
 */
export interface FeaturedCollectionRow {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly sort_order: number
}

/** Full detail for the collection screen/modal. */
export interface CollectionDetail {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly description: string
  readonly trackIds: readonly string[]
}

/** A collection a given track belongs to — used to group the playlist. */
export interface TrackCollectionRef {
  readonly id: string
  readonly name: string
}

export interface ISqlCollectionRepository {
  /**
   * Featured collections for `locale` (carrying the `tag_featured` tag),
   * ordered by `sort_order ASC` then `id ASC`. Returns an empty array (not
   * throws) when the catalog DB has no collection tables — the Home view
   * degrades to its empty-state in that case.
   */
  listFeaturedCollections(locale: string): Promise<readonly FeaturedCollectionRow[]>

  /**
   * Ordered list of track ids for one collection locale. Empty array when
   * the collection has no members yet, or when the tables are missing.
   * Order is `position ASC`.
   */
  getCollectionTrackIds(collectionId: string, locale: string): Promise<readonly string[]>

  /** Name + cover + description + ordered tracks for the detail surface. */
  getCollection(collectionId: string, locale: string): Promise<CollectionDetail | null>

  /**
   * Collections (id + name) the given track belongs to in `locale`, ordered
   * by `sort_order ASC`. Drives playlist grouping by derivation — no
   * per-item provenance is stored.
   */
  getTrackCollections(trackId: string, locale: string): Promise<readonly TrackCollectionRef[]>
}

/**
 * Capacitor-SQLite-backed read-only repository for collections. The publisher
 * of `current.db` owns the table schema; this repo only reads.
 *
 * We treat `no such table: collections` as "no collections available" rather
 * than an error so a freshly-shipped mobile binary against an older bundled DB
 * stays usable. Any other SQL error is rethrown so legitimate bugs surface.
 */
export function createSqlCollectionRepository(contentDb: IDatabase): ISqlCollectionRepository {
  async function queryTrackIds(collectionId: string, locale: string): Promise<readonly string[]> {
    const rows = await contentDb.query<{ track_id: string }>(
      `SELECT track_id
         FROM collection_tracks
        WHERE collection_id = ? AND collection_language = ?
        ORDER BY position ASC, track_id ASC`,
      [collectionId, locale]
    )
    return rows.map((r) => r.track_id)
  }

  return {
    async listFeaturedCollections(locale: string): Promise<readonly FeaturedCollectionRow[]> {
      try {
        return await contentDb.query<FeaturedCollectionRow>(
          `SELECT c.id, c.name, COALESCE(c.cover, '') AS cover, c.sort_order
             FROM collections c
             JOIN collection_tags ct
               ON ct.collection_id = c.id AND ct.collection_language = c.language
            WHERE c.language = ? AND ct.tag_id = 'tag_featured'
            ORDER BY c.sort_order ASC, c.id ASC`,
          [locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getCollectionTrackIds(collectionId: string, locale: string): Promise<readonly string[]> {
      try {
        return await queryTrackIds(collectionId, locale)
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getCollection(collectionId: string, locale: string): Promise<CollectionDetail | null> {
      try {
        const rows = await contentDb.query<{
          name: string
          cover: string | null
          description: string | null
        }>(
          `SELECT name, cover, description
             FROM collections
            WHERE id = ? AND language = ?
            LIMIT 1`,
          [collectionId, locale]
        )
        if (rows.length === 0) return null
        const trackIds = await queryTrackIds(collectionId, locale)
        return {
          id: collectionId,
          name: rows[0].name,
          cover: rows[0].cover ?? "",
          description: rows[0].description ?? "",
          trackIds,
        }
      } catch (err) {
        if (isMissingTable(err)) return null
        throw err
      }
    },

    async getTrackCollections(
      trackId: string,
      locale: string
    ): Promise<readonly TrackCollectionRef[]> {
      try {
        return await contentDb.query<TrackCollectionRef>(
          `SELECT c.id, c.name
             FROM collection_tracks ctk
             JOIN collections c
               ON c.id = ctk.collection_id AND c.language = ctk.collection_language
            WHERE ctk.track_id = ? AND ctk.collection_language = ?
            ORDER BY c.sort_order ASC, c.id ASC`,
          [trackId, locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },
  }
}

/**
 * SQLite returns `no such table: <name>` when a query hits a table that
 * hasn't been created. We surface that as "no collections" so the mobile
 * binary can ship ahead of the catalog schema.
 *
 * Both `sql.js` (web) and `@capacitor-community/sqlite` (native) include the
 * table name in the message, so a substring match is sufficient.
 */
function isMissingTable(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*(collections|collection_tracks|collection_tags)\b/i.test(message)
}
