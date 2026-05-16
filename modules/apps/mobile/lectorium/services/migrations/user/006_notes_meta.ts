import type { Migration } from "./types.js"

/**
 * Free-form JSON sidecar attached to a note. First consumer is the
 * Studio editor, which stores a quote tweaked for video rendering under
 * `meta.studio.text`. Schema is intentionally open — repositories
 * round-trip the column as `Record<string, unknown> | null` and the
 * domain layer doesn't enforce a shape.
 */
export const migration_006_notes_meta: Migration = {
  name: "006_notes_meta",
  up: async (db) => {
    await db.execute("ALTER TABLE notes ADD COLUMN meta TEXT")
  },
}
