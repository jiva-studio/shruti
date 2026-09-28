import type { IDatabase } from "@ports/app/index.js"
import type { Migration } from "./types.js"

/**
 * Enforces **one `playlist_items` row per `track_id`**.
 *
 * `track_id` is the sync doc id for this collection (`mergePlaylistItem` is
 * add-wins, keyed by track_id), and the wire cannot express a second row for
 * the same track. A local duplicate is a shadow the server never sees, and
 * lookups that pick different rows put reads and writes on different rows.
 *
 * ## The fold
 *
 * Per duplicated track the survivor is the newest add (`added_at DESC, id
 * DESC`, the same pick `readLocalRow` makes), and its fields are recomputed by
 * the add-wins rule: newest add, newest archive, active iff the add is at least
 * as recent as the archive, provenance from the newest add falling back to any
 * non-null. The losers are deleted.
 *
 * **Listening sessions are re-pointed, never dropped.** Every
 * `listening_sessions` row keyed on a loser moves to the survivor first.
 * Progress, completion and the heatmap all read per `item_id`, so the union is
 * the track's whole history. Per-item progress is scoped to sessions at or
 * after the survivor's `added_at` (`CURRENT_PASS`), so the survivor does not
 * inherit a shadow's completed badge.
 *
 * Not journaled, like migration 016: folding changes no document identity —
 * `playlist_items` docs are keyed by `track_id`, and a session's doc id is its
 * own `id`, whose wire `item_id` every receiver re-keys by `track_id`.
 *
 * ## Never throws
 *
 * A throw aborts every later migration and `startup.ts` swallows the error, so
 * the unique index is created only after re-checking that no duplicate
 * survived, with a plain index as the fallback: deterministic reads, constraint
 * unenforced.
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
