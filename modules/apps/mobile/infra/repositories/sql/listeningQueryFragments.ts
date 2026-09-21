/**
 * Bound on `?` parameters in one statement. The builds we ship (sql.js, the
 * SQLite inside @capacitor-community/sqlite v8) allow 32766, but the pre-3.32
 * limit of 999 is cheap to stay under, so chunk.
 */
export const ID_CHUNK_SIZE = 500

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * Restricts a session scan to the item's **current pass** — the listening it
 * has accumulated since it was last added to the playlist.
 *
 * `playlist_items` holds one row per `track_id` and a re-add resurrects it
 * with a new `added_at`, so the pass boundary is read off `added_at` rather
 * than inferred from a row id that no longer churns. `added_at` is unix
 * MILLIseconds, `ended_at` unix seconds.
 *
 * LEFT JOIN, and NULL-tolerant: a session can be keyed on an item id with no
 * playlist row — playback outside the playlist writes a synthetic
 * `track:<id>` item id, and removing an item leaves its sessions behind.
 * Those have no pass boundary, so they stay in scope.
 */
export const CURRENT_PASS = {
  join: "LEFT JOIN playlist_items pass_item ON pass_item.id = ls.item_id",
  where: "(pass_item.added_at IS NULL OR ls.ended_at >= pass_item.added_at / 1000)",
}
