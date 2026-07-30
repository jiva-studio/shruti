import type { Migration } from "./types.js"

/**
 * Personal-library description + chapter outline. The ingest pipeline runs the
 * shared outline step over the reviewed transcript and projects a short
 * `description` plus a coarse `outline` (chapters with ms spans) onto the
 * profile-sync payload. Stored here so the track sheet shows an overview and a
 * table of contents, matching corpus tracks. `outline_json` holds the raw
 * `[{"title","start","end"}]` array. Both NULL on rows added before this landed.
 */
export const migration_019_library_items_outline: Migration = {
  name: "019_library_items_outline",
  up: async (db) => {
    await db.execute(`ALTER TABLE library_items ADD COLUMN description TEXT`)
    await db.execute(`ALTER TABLE library_items ADD COLUMN outline_json TEXT`)
  },
}
