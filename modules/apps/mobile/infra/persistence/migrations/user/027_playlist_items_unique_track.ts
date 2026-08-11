import type { IDatabase } from "@ports/app/index.js"
import type { Migration } from "./types.js"

/**
 * **One `playlist_items` row per `track_id`** — the invariant the sync layer
 * has always assumed and the table never enforced (#1736).
 *
 * `track_id` IS the sync doc id for this collection: `mergePlaylistItem` is
 * documented as "add-wins, keyed by track_id", and the wire has no way to
 * express a second row for the same track. A local second row is therefore not
 * a second document — it is a shadow the server can never see, and whichever
 * of the two a lookup happens to hit decides what the user gets. That is what
 * broke: `readLocalRow` merged from the newest row while `upsertPlaylist` and
 * the session re-key wrote to an unordered `LIMIT 1` (a rowid scan → the
 * older, archived row), so a pulled change resurrected the archived row and
 * every listening session for the track was re-keyed onto it. `listActive()`
 * returned the lecture twice and its resume position vanished.
 *
 * Duplicates arise from `addTrackToPlaylist`, which de-dupes against ACTIVE
 * rows only: archive-then-re-add inserted a second row. That path is fixed to
 * resurrect the existing row in place, so this migration only has to fold the
 * duplicates devices already carry.
 *
 * ## The fold
 *
 * Per duplicated track: the survivor is the newest add (`added_at DESC, id
 * DESC` — the same pick `readLocalRow` makes, so a device folds to the row it
 * was already reading from), and its fields are recomputed by the domain's own
 * add-wins rule (`mergePlaylistItem`): newest add, newest archive, active iff
 * the add is at least as recent as the archive, provenance from the newest add
 * falling back to any non-null. The losers are deleted.
 *
 * **Listening sessions are re-pointed, never dropped.** Every
 * `listening_sessions` row keyed on a loser is moved to the survivor before
 * the loser goes away — losing them is the very bug this fixes. Progress
 * (`MAX(to_position)`), completion (latest session) and the heatmap all read
 * per `item_id`, so the union is exactly the history the track really has.
 *
 * Sync-safe and NOT journaled, like migration 016:
 *   - `playlist_items` docs are keyed by `track_id`, so folding two rows into
 *     one changes no document identity — the outbox and `sync_doc_hlc` rows
 *     for the track keep pointing at the same doc.
 *   - a session's doc id is its own `id`, which is untouched; its wire
 *     `item_id` is a device-local surrogate that every receiver re-keys by
 *     `track_id` anyway — and both rows carried the SAME `track_id`, so the
 *     snapshot a later push takes is unchanged.
 *
 * ## Never throws
 *
 * One throw in the ordered list aborts every later migration permanently and
 * `startup.ts` swallows the error, so the unique index is created only after
 * re-checking that no duplicate survived, with a plain index as the fallback.
 * A device that lands on the fallback still gets the index (these lookups were
 * table scans regardless) and still reads deterministically — it just keeps
 * the constraint unenforced rather than bricking its migration chain.
 *
 * Idempotent: a re-run finds no duplicate groups and both `CREATE INDEX`
 * statements are `IF NOT EXISTS`.
 */
export const migration_027_playlist_items_unique_track: Migration = {
  name: "027_playlist_items_unique_track",
  up: async (db) => {
    await foldDuplicates(db)

    if ((await duplicateTrackIds(db, 1)).length === 0) {
      try {
        await db.execute(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_items_track
             ON playlist_items(track_id)`
        )
        return
      } catch {
        // Something we did not anticipate still violates uniqueness. Fall
        // through to the plain index rather than abort the migration chain.
      }
    }
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_playlist_items_track_scan
         ON playlist_items(track_id)`
    )
  },
}

interface DuplicateRow {
  id: string
  added_at: number
  archived_at: number | null
  collection_id: string | null
}

/** Track ids carrying more than one row, at most `limit` of them. */
async function duplicateTrackIds(db: IDatabase, limit?: number): Promise<string[]> {
  const rows = await db.query<{ track_id: string }>(
    `SELECT track_id FROM playlist_items
      GROUP BY track_id HAVING COUNT(*) > 1
      ${limit === undefined ? "" : `LIMIT ${limit}`}`
  )
  return rows.map((r) => r.track_id)
}

/** Collapse every duplicated track onto one row, carrying its sessions over. */
async function foldDuplicates(db: IDatabase): Promise<void> {
  for (const trackId of await duplicateTrackIds(db)) {
    const rows = await db.query<DuplicateRow>(
      `SELECT id, added_at, archived_at, collection_id
         FROM playlist_items
        WHERE track_id = ?
        ORDER BY added_at DESC, id DESC`,
      [trackId]
    )
    const survivor = rows[0]
    if (survivor === undefined) continue

    const addedAt = Math.max(...rows.map((r) => r.added_at))
    const archives = rows.map((r) => r.archived_at).filter((v): v is number => v !== null)
    const newestArchive = archives.length > 0 ? Math.max(...archives) : null
    // Add-wins: an archive only stands when it is newer than the newest add.
    const archivedAt = newestArchive !== null && newestArchive > addedAt ? newestArchive : null
    // `rows` is newest-add-first, so this is the survivor's provenance when it
    // has one and the next-newest non-null otherwise.
    const collectionId = rows.find((r) => r.collection_id !== null)?.collection_id ?? null

    for (const loser of rows.slice(1)) {
      await db.execute("UPDATE listening_sessions SET item_id = ? WHERE item_id = ?", [
        survivor.id,
        loser.id,
      ])
      await db.execute("DELETE FROM playlist_items WHERE id = ?", [loser.id])
    }
    await db.execute(
      "UPDATE playlist_items SET added_at = ?, archived_at = ?, collection_id = ? WHERE id = ?",
      [addedAt, archivedAt, collectionId, survivor.id]
    )
  }
}
