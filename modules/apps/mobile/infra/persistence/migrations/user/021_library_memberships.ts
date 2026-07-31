import type { Migration } from "./types.js"

/**
 * Personal-library membership — the user's remove/re-add intent for a library
 * item, CLIENT-owned and pushed like playlist_items. `id` is the library item
 * id (= library_items.id, the sync doc_id); `archived_at` NULL = active, set =
 * removed. A row exists only once the user has acted on the item — absence
 * means active, so existing users need no backfill.
 */
export const migration_021_library_memberships: Migration = {
  name: "021_library_memberships",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS library_memberships (
        id           TEXT PRIMARY KEY,
        archived_at  INTEGER,
        updated_at   INTEGER
      )
    `)
  },
}
