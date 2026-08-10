import type { Migration } from "./types.js"

/**
 * Profile-sync write-path tables (Lane B).
 *
 * `outbox` is an append-only journal of local changes awaiting push to the
 * `profile` service. Every upsert/delete on a synced collection
 * (`playlist_items`, `listening_sessions`, `notes`) writes one row here in the
 * SAME transaction as the domain write (see the sync-journal decorator), so a
 * change and its journal entry are atomic. The autoincrement `id` is the local
 * cursor: pending rows are `sent = 0` with `id` above the last pushed id.
 * `hlc` is the change's Hybrid Logical Clock stamp; `base_hlc` is the
 * last-seen server HLC the doc derived from (NULL for a new doc / until the
 * sync engine fills it before push).
 *
 * `sync_state` is per-device bookkeeping for the engine (Lane D): the pull
 * cursor, the cursor acknowledged to the server for compaction, and
 * `pushed_outbox_id` — the outbox watermark below which rows are retired,
 * either because they were pushed or because the owning identity changed.
 *
 * Both are additive `CREATE TABLE IF NOT EXISTS` — no existing table is
 * touched or renamed.
 */
export const migration_013_sync_outbox: Migration = {
  name: "013_sync_outbox",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        collection  TEXT    NOT NULL,
        doc_id      TEXT    NOT NULL,
        op          TEXT    NOT NULL,
        data        TEXT,
        hlc         TEXT    NOT NULL,
        base_hlc    TEXT,
        created_at  INTEGER NOT NULL,
        sent        INTEGER NOT NULL DEFAULT 0
      )
    `)
    // Pending-scan index: the engine reads unsent rows in insertion order.
    await db.execute("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent, id)")

    await db.execute(`
      CREATE TABLE IF NOT EXISTS sync_state (
        device_id        TEXT    PRIMARY KEY,
        pull_cursor      INTEGER NOT NULL DEFAULT 0,
        acked_seq        INTEGER NOT NULL DEFAULT 0,
        pushed_outbox_id INTEGER NOT NULL DEFAULT 0,
        updated_at       INTEGER NOT NULL DEFAULT 0
      )
    `)
  },
}
