import type { IDatabase } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import { libraryItemToTrack } from "@lib/domain/libraryItem.js"
import type { Track } from "@lib/domain/track.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"
import type { LibraryItemRow } from "@lib/persistence/user"
import { queryMany, queryOne } from "@kit/persistence"
import { rowToLibraryItem } from "./rowMappers.js"

/**
 * SQL adapter over `library_items` (017 migration) — the on-device projection
 * of the server-owned personal-library collection. **Read-only**: the rows are
 * written exclusively by the sync-apply adapter (pull-only), never here.
 *
 * `getTrackByTrackId` composes the read with the `libraryItemToTrack` synthetic
 * adapter so the existing playback stack can resolve a user track by content
 * hash exactly as it resolves a corpus track.
 */
export function createSqlLibraryItemRepository(db: IDatabase): ILibraryItemRepository {
  return {
    async getById(id: string): Promise<LibraryItem | null> {
      return queryOne<LibraryItemRow, LibraryItem>(
        db,
        "SELECT * FROM library_items WHERE id = ?",
        [id],
        rowToLibraryItem
      )
    },

    async getByTrackId(trackId: TrackId): Promise<LibraryItem | null> {
      // Several membership rows can share a track_id across users, but on ONE
      // device there is at most the local owner's single row per content hash.
      // Prefer the most recently updated should a stale duplicate ever exist.
      return queryOne<LibraryItemRow, LibraryItem>(
        db,
        "SELECT * FROM library_items WHERE track_id = ? ORDER BY updated_at DESC LIMIT 1",
        [trackId],
        rowToLibraryItem
      )
    },

    async listAll(): Promise<readonly LibraryItem[]> {
      // Newest-added first. Prefer created_at, but a freshly ingested item may
      // not have it stamped yet — fall back to updated_at (its last status
      // flip), then to insertion order (rowid) — so the just-added lecture
      // still sorts to the top instead of the bottom.
      return queryMany<LibraryItemRow, LibraryItem>(
        db,
        "SELECT * FROM library_items ORDER BY COALESCE(created_at, updated_at, 0) DESC, rowid DESC",
        [],
        rowToLibraryItem
      )
    },

    async getTrackByTrackId(trackId: TrackId): Promise<Track | null> {
      const item = await queryOne<LibraryItemRow, LibraryItem>(
        db,
        "SELECT * FROM library_items WHERE track_id = ? ORDER BY updated_at DESC LIMIT 1",
        [trackId],
        rowToLibraryItem
      )
      return item ? libraryItemToTrack(item) : null
    },
  }
}
