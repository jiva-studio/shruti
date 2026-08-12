import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Source URL of a personal-library item. The server already projects it on the
 * ready payload; persist it so search can mark a candidate the user already
 * has (matched by the URL / its YouTube id). NULL on rows added before this.
 */
export const migration_020_library_items_source_url: Migration = {
  name: "020_library_items_source_url",
  up: async (db) => {
    await addColumnIfMissing(db, "library_items", "source_url", "source_url TEXT")
  },
}
