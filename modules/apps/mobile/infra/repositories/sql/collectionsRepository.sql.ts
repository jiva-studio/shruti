import type { IDatabase } from "@ports/app/index.js"
import type {
  CollectionAuthor,
  CollectionDetail,
  CollectionGroupRow,
  FeaturedCollectionRow,
  ISqlCollectionRepository,
  TrackCollectionRow,
} from "./collectionTypes.js"

import { isMissingColumn, isMissingTable } from "./catalogSchemaTolerance.js"

export type * from "./collectionTypes.js"

/**
 * Capacitor-SQLite-backed read-only repository for collections. The publisher
 * of `current.db` owns the table schema; this repo only reads.
 *
 * We treat `no such table: collections` as "no collections available" rather
 * than an error so a freshly-shipped mobile binary against an older bundled DB
 * stays usable. Any other SQL error is rethrown so legitimate bugs surface.
 */
export function createSqlCollectionRepository(contentDb: IDatabase): ISqlCollectionRepository {
  /** Hidden tracks are excluded everywhere in `tracksRepository`, and
   *  `tracks.getByIds` — which every caller feeds these ids into — drops them
   *  anyway, so handing them out only makes a page short. */
  const VISIBLE_TRACK = `EXISTS (SELECT 1 FROM tracks tk
                                  WHERE tk.id = ct.track_id AND tk.hidden = 0)`

  async function queryTrackIds(collectionId: string, locale: string): Promise<readonly string[]> {
    const rows = await contentDb.query<{ track_id: string }>(
      `SELECT ct.track_id
         FROM collection_tracks ct
        WHERE ct.collection_id = ? AND ct.collection_language = ?
          AND ${VISIBLE_TRACK}
        ORDER BY ct.position ASC, ct.track_id ASC`,
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

    async getCollectionName(collectionId: string, locale: string): Promise<string | null> {
      try {
        const rows = await contentDb.query<{ name: string }>(
          `SELECT name FROM collections WHERE id = ? AND language = ? LIMIT 1`,
          [collectionId, locale]
        )
        return rows.length > 0 ? rows[0].name : null
      } catch (err) {
        if (isMissingTable(err)) return null
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
              AND t.hidden = 0
            GROUP BY a.id
            ORDER BY COUNT(*) DESC, a.full_name ASC`,
          [collectionId, locale]
        )
      } catch (err) {
        // Also tolerate an older catalog DB that predates authors.image /
        // authors.description (no such column), not just missing tables.
        if (isMissingTable(err) || isMissingColumn(err)) return []
        throw err
      }
    },

    async listGroups(locale: string): Promise<readonly CollectionGroupRow[]> {
      try {
        return await contentDb.query<CollectionGroupRow>(
          `SELECT id, name, COALESCE(description, '') AS description
             FROM collection_groups
            WHERE language = ?
            ORDER BY sort_order ASC, id ASC`,
          [locale]
        )
      } catch (err) {
        if (isMissingTable(err)) return []
        throw err
      }
    },

    async getCollectionsOfTrack(
      trackId: string,
      locale: string
    ): Promise<readonly TrackCollectionRow[]> {
      try {
        return await contentDb.query<TrackCollectionRow>(
          `SELECT c.id,
                  c.name,
                  COALESCE(c.cover, '') AS cover,
                  (SELECT COUNT(*)
                     FROM collection_tracks p
                    WHERE p.collection_id = ct.collection_id
                      AND p.collection_language = ct.collection_language
                      AND EXISTS (SELECT 1 FROM tracks tk
                                   WHERE tk.id = p.track_id AND tk.hidden = 0)
                      AND (p.position < ct.position
                           OR (p.position = ct.position AND p.track_id <= ct.track_id))
                  ) AS position,
                  (SELECT COUNT(*)
                     FROM collection_tracks a
                    WHERE a.collection_id = ct.collection_id
                      AND a.collection_language = ct.collection_language
                      AND EXISTS (SELECT 1 FROM tracks tk
                                   WHERE tk.id = a.track_id AND tk.hidden = 0)
                  ) AS total
             FROM collection_tracks ct
             JOIN collections c
               ON c.id = ct.collection_id AND c.language = ct.collection_language
            WHERE ct.track_id = ? AND ct.collection_language = ?
            ORDER BY c.name ASC`,
          [trackId, locale]
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
