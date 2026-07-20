import type { Migration } from "./types.js"

/**
 * Personal library — lectures the user added that are NOT in the shared corpus
 * (ingested via the `orchestrator` service; see the Personal Library epic
 * #1236). Metadata is owned by the `profile` service and reaches the device
 * over the existing profile-sync as a new **pull-only** collection: the client
 * only ever APPLIES the server's version — there is no outbox, no journal, and
 * no merge beyond last-writer-is-the-server.
 *
 * `id` is the per-user membership id (UUID), assigned at submit so the app can
 * show "processing" immediately; `track_id` is the content hash, NULL until the
 * fetch step computes it. `listening_sessions` / `notes` / `playlist_items`
 * still key off `track_id`, which is safe because those only accrue once a
 * track is playable (by which point `track_id` exists).
 *
 * Columns mirror `profile.library_items` (see
 * docs/repos/shruti/architecture/personal-library.md § Data model). Metadata
 * is captured in three states per dimension: `*_raw` (always, lossless), the
 * resolved id/value (only when confidently matched), and a status/confidence.
 */
export const migration_017_library_items: Migration = {
  name: "017_library_items",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS library_items (
        id              TEXT PRIMARY KEY,
        track_id        TEXT,
        status          TEXT NOT NULL,
        origin          TEXT,
        title_raw       TEXT,
        author_raw      TEXT,
        location_raw    TEXT,
        date_raw        TEXT,
        lang_hint       TEXT,
        author_id       TEXT,
        location_id     TEXT,
        date            TEXT,
        date_precision  TEXT,
        lang            TEXT,
        lang_confidence REAL,
        error           TEXT,
        audio_key       TEXT,
        transcript_key  TEXT,
        duration        INTEGER,
        cover_key       TEXT,
        created_at      INTEGER,
        updated_at      INTEGER
      )
    `)
    // Membership rows key off track_id for the synthetic-Track / playback path.
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_library_items_track_id ON library_items(track_id)"
    )
    // The "My library" shelf lists newest-first by creation.
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_library_items_created_at ON library_items(created_at DESC)"
    )
  },
}
