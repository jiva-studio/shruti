import type { Migration } from "./types.js"

/**
 * Provenance for playlist items: the collection a track was added FROM, set
 * only when the user added a whole collection ("add all"). NULL for tracks
 * added individually (search, chat, a single lecture inside a collection).
 *
 * This replaces the old derive-by-membership grouping on Home (which inferred
 * collections from `collection_tracks` + row adjacency) with an explicit,
 * intent-based record. Existing rows migrate to NULL → they render as
 * standalone tracks, which is correct: we don't know their real provenance.
 */
export const migration_012_playlist_items_collection_id: Migration = {
  name: "012_playlist_items_collection_id",
  up: async (db) => {
    await db.execute("ALTER TABLE playlist_items ADD COLUMN collection_id TEXT")
  },
}
