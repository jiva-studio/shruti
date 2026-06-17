import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { PlaylistItemRow } from "@lib/persistence/user"
import { mutate, queryMany, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToPlaylistItem } from "./rowMappers.js"

const newPlaylistItemId = createIdGenerator("playlist")

export function createSqlPlaylistItemRepository(db: IDatabase): IPlaylistItemRepository {
  return {
    async getById(id: PlaylistItemId): Promise<PlaylistItem | null> {
      return queryOne<PlaylistItemRow, PlaylistItem>(
        db,
        "SELECT * FROM playlist_items WHERE id = ?",
        [id],
        rowToPlaylistItem
      )
    },

    async listActive(): Promise<readonly PlaylistItem[]> {
      return queryMany<PlaylistItemRow, PlaylistItem>(
        db,
        "SELECT * FROM playlist_items WHERE archived_at IS NULL ORDER BY added_at ASC",
        [],
        rowToPlaylistItem
      )
    },

    async listArchived(): Promise<readonly PlaylistItem[]> {
      return queryMany<PlaylistItemRow, PlaylistItem>(
        db,
        "SELECT * FROM playlist_items WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
        [],
        rowToPlaylistItem
      )
    },

    async add(trackId: TrackId, collectionId: string | null = null): Promise<PlaylistItem> {
      const id = newPlaylistItemId()
      const now = Date.now()
      await mutate(
        db,
        `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id)
         VALUES (?, ?, ?, NULL, ?)`,
        [id, trackId, now, collectionId]
      )
      return {
        id,
        trackId,
        addedAt: now,
        archivedAt: null,
        collectionId,
      }
    },

    async archive(id: PlaylistItemId): Promise<void> {
      await mutate(db, "UPDATE playlist_items SET archived_at = ? WHERE id = ?", [Date.now(), id])
    },

    async remove(id: PlaylistItemId): Promise<void> {
      await mutate(db, "DELETE FROM playlist_items WHERE id = ?", [id])
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM playlist_items")
    },
  }
}
