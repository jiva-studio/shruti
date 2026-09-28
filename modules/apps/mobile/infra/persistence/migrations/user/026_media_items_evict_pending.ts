import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * A durable home for "this file is owed an eviction".
 *
 * Archiving a lecture the native engine can still reach has to leave its audio
 * on disk. The debt is recorded on the row so it survives a force-close and the
 * next launch can finish the eviction: nothing else in the app collects orphaned
 * files.
 *
 * Local user-DB only — no content scheme gate, no release coupling.
 */
export const migration_026_media_items_evict_pending: Migration = {
  name: "026_media_items_evict_pending",
  up: async (db) => {
    await addColumnIfMissing(
      db,
      "media_items",
      "evict_pending",
      "evict_pending INTEGER NOT NULL DEFAULT 0"
    )
  },
}
