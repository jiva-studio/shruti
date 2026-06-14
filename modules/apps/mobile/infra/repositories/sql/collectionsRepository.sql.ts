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
  readonly description?: string
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

/** A named group (shelf) of collections, as shown on the Search page. */
export interface CollectionGroupRow {
  readonly id: string
  readonly name: string
}

/**
 * The author behind a collection (derived from its tracks' dominant author).
 * `image` is an S3 asset key for the avatar; `description` a short bio. Both
 * are empty when not yet published — the UI then shows name only / no avatar.
 */
export interface CollectionAuthor {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly description: string
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
   * All collections for `locale`, ordered by `sort_order ASC` then `id ASC`.
   * Used by the Search page's "other collections" list. Empty array when the
   * tables are missing.
   */
  listCollections(locale: string): Promise<readonly FeaturedCollectionRow[]>

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

  /**
   * Distinct authors of a collection, ordered by how many of its tracks each
   * one wrote (dominant first), each with avatar + short bio. Empty when the
   * collection has no tracks / no resolvable authors, or the catalog DB
   * predates the author profile columns. Drives the collection-card avatar
   * pile (overlapping circles) and the detail-sheet header.
   */
  getCollectionAuthors(collectionId: string, locale: string): Promise<readonly CollectionAuthor[]>

  /** Named collection-groups for `locale`, ordered by `sort_order`. */
  listGroups(locale: string): Promise<readonly CollectionGroupRow[]>

  /** Collection headers of one group, in the group's defined order. */
  getGroupCollections(groupId: string, locale: string): Promise<readonly FeaturedCollectionRow[]>
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

    async listCollections(locale: string): Promise<readonly FeaturedCollectionRow[]> {
      try {
        return await contentDb.query<FeaturedCollectionRow>(
          `SELECT id, name, COALESCE(cover, '') AS cover, sort_order,
                  COALESCE(description, '') AS description
             FROM collections
            WHERE language = ?
            ORDER BY sort_order ASC, id ASC`,
          [locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getCollectionAuthors(
      collectionId: string,
      locale: string
    ): Promise<readonly CollectionAuthor[]> {
      try {
        return await contentDb.query<CollectionAuthor>(
          `SELECT a.id,
                  a.full_name AS name,
                  COALESCE(a.image, '') AS image,
                  COALESCE(a.description, '') AS description
             FROM collection_tracks ctk
             JOIN tracks t ON t.id = ctk.track_id
             JOIN authors a ON a.id = t.author_id AND a.language = ctk.collection_language
            WHERE ctk.collection_id = ? AND ctk.collection_language = ?
            GROUP BY a.id
            ORDER BY COUNT(*) DESC, a.full_name ASC`,
          [collectionId, locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async listGroups(locale: string): Promise<readonly CollectionGroupRow[]> {
      try {
        return await contentDb.query<CollectionGroupRow>(
          `SELECT id, name FROM collection_groups
            WHERE language = ?
            ORDER BY sort_order ASC, id ASC`,
          [locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getGroupCollections(
      groupId: string,
      locale: string
    ): Promise<readonly FeaturedCollectionRow[]> {
      try {
        return await contentDb.query<FeaturedCollectionRow>(
          `SELECT c.id, c.name, COALESCE(c.cover, '') AS cover, c.sort_order,
                  COALESCE(c.description, '') AS description
             FROM collection_group_items gi
             JOIN collections c
               ON c.id = gi.collection_id AND c.language = gi.group_language
            WHERE gi.group_id = ? AND gi.group_language = ?
            ORDER BY gi.position ASC`,
          [groupId, locale]
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
  return /no such table:\s*(collections|collection_tracks|collection_tags|collection_groups|collection_group_items)\b/i.test(
    message
  )
}
