import type { Migration } from "./types.js"

/**
 * Per-language transcripts for a personal-library item. A lecturer+translator
 * recording is transcribed into one `transcripts/<lang>.json` per language;
 * `variants_json` holds the raw `[{"lang","transcript_key"}]` array so the
 * multi-language transcript viewer can offer a flag per language. NULL on
 * single-language / older rows (the scalar `transcript_key` is used then).
 */
export const migration_022_library_items_variants: Migration = {
  name: "022_library_items_variants",
  up: async (db) => {
    await db.execute(`ALTER TABLE library_items ADD COLUMN variants_json TEXT`)
  },
}
