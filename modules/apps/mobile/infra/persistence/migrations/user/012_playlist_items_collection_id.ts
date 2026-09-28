import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Provenance for playlist items: the collection a track was added FROM, set
 * only when the user added a whole collection ("add all"). NULL for tracks
 * added individually (search, chat, a single lecture inside a collection).
 *
 * Home groups by this explicit, intent-based record. Existing rows migrate to
 * NULL and render as standalone tracks, since their provenance is unknown.
 */
export const migration_012_playlist_items_collection_id: Migration = {
  name: "012_playlist_items_collection_id",
  up: async (db) => {
    await addColumnIfMissing(db, "playlist_items", "collection_id", "collection_id TEXT")
  },
}
