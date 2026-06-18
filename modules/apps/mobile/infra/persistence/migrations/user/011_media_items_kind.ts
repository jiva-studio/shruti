import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Per-version offline cache: a track can now cache more than one audio
 * file — the noisy `original` and the denoised `clean`. Add a `kind`
 * column (existing rows are the `original`) and key uniqueness by
 * (track_id, kind) so both can coexist. Local user-DB only — no content
 * scheme gate, no release coupling.
 */
export const migration_011_media_items_kind: Migration = {
  name: "011_media_items_kind",
  up: async (db) => {
    await addColumnIfMissing(db, "media_items", "kind", "kind TEXT NOT NULL DEFAULT 'original'")
    // Replace the per-track unique index with a per-(track, kind) one.
    await db.execute("DROP INDEX IF EXISTS idx_media_items_track")
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_track_kind ON media_items(track_id, kind)"
    )
  },
}
