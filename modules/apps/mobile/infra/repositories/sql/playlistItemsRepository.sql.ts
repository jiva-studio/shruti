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

    /**
     * Upsert by track: one row per `track_id` (migration 027), because
     * `track_id` is the sync doc id and a second row is a document no server
     * can see. Re-adding a track that was archived earlier RESURRECTS that
     * row — clearing `archived_at` and taking the new `added_at` — instead of
     * inserting a duplicate, which is both what the add-wins merge rule
     * resolves to and what the unique index now requires.
     */
    async add(trackId: TrackId, collectionId: string | null = null): Promise<PlaylistItem> {
      const now = Date.now()
      const existing = await queryOne<PlaylistItemRow, PlaylistItem>(
        db,
        "SELECT * FROM playlist_items WHERE track_id = ? ORDER BY added_at DESC, id DESC LIMIT 1",
        [trackId],
        rowToPlaylistItem
      )
      if (existing) {
        // Provenance follows the newest add, keeping a non-null when the row
        // already had one — same rule as `mergePlaylistItem`.
        const nextCollectionId = collectionId ?? existing.collectionId
        await mutate(
          db,
          "UPDATE playlist_items SET added_at = ?, archived_at = NULL, collection_id = ? WHERE id = ?",
          [now, nextCollectionId, existing.id]
        )
        return {
          id: existing.id,
          trackId,
          addedAt: now,
          archivedAt: null,
          collectionId: nextCollectionId,
        }
      }
      const id = newPlaylistItemId()
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
