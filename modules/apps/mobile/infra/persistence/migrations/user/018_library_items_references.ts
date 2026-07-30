import type { Migration } from "./types.js"

/**
 * Personal-library scripture references. The ingest metadata extractor pulls
 * references out of the title (e.g. "BG 2.13"); they ride the profile-sync
 * payload as a raw `[{source, tokens}]` array and are stored here verbatim as
 * JSON. Kept as a single column (not a child table) because the collection is
 * pull-only and read whole per item — the app parses this into the Track's
 * `references` for the reference chips. NULL on rows added before this landed.
 */
export const migration_018_library_items_references: Migration = {
  name: "018_library_items_references",
  up: async (db) => {
    await db.execute(`ALTER TABLE library_items ADD COLUMN references_json TEXT`)
  },
}
