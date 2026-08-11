import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * A durable home for "this file is owed an eviction".
 *
 * Archiving a lecture the native engine can still reach has to leave its audio
 * on disk, and until now the debt lived in a `Set` at module scope in the
 * player. A force-close in that window took the record with it: nothing else
 * in the app collects orphans, so the megabytes counted against the storage
 * budget until uninstall (issue #1666). Recording it on the row means the next
 * launch can finish the job.
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
