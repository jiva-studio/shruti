import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { PlaylistItemRow } from "@lib/persistence/user"
import { createIdGenerator } from "./idGenerator.js"
import { rowToPlaylistItem } from "./rowMappers.js"

const newPlaylistItemId = createIdGenerator("playlist")

export function createSqlPlaylistItemRepository(db: IDatabase): IPlaylistItemRepository {
  return {
    async getById(id: PlaylistItemId): Promise<PlaylistItem | null> {
      const rows = await db.query<PlaylistItemRow>("SELECT * FROM playlist_items WHERE id = ?", [
        id,
      ])
      return rows[0] ? rowToPlaylistItem(rows[0]) : null
    },

    async listActive(): Promise<readonly PlaylistItem[]> {
      const rows = await db.query<PlaylistItemRow>(
        "SELECT * FROM playlist_items WHERE archived_at IS NULL ORDER BY added_at DESC"
      )
      return rows.map(rowToPlaylistItem)
    },

    async listArchived(): Promise<readonly PlaylistItem[]> {
      const rows = await db.query<PlaylistItemRow>(
        "SELECT * FROM playlist_items WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
      )
      return rows.map(rowToPlaylistItem)
    },

    async add(trackId: TrackId): Promise<PlaylistItem> {
      const id = newPlaylistItemId()
      const now = Date.now()
      await db.execute(
        `INSERT INTO playlist_items (id, track_id, added_at, completed_at, archived_at, progress)
         VALUES (?, ?, ?, NULL, NULL, NULL)`,
        [id, trackId, now]
      )
      await db.save()
      return {
        id,
        trackId,
        addedAt: now,
        completedAt: null,
        archivedAt: null,
        progress: null,
      }
    },

    async updateProgress(id: PlaylistItemId, progressMs: number): Promise<void> {
      await db.execute("UPDATE playlist_items SET progress = ? WHERE id = ?", [progressMs, id])
      await db.save()
    },

    async markCompleted(id: PlaylistItemId): Promise<void> {
      await db.execute("UPDATE playlist_items SET completed_at = ? WHERE id = ?", [Date.now(), id])
      await db.save()
    },

    async archive(id: PlaylistItemId): Promise<void> {
      await db.execute("UPDATE playlist_items SET archived_at = ? WHERE id = ?", [Date.now(), id])
      await db.save()
    },

    async remove(id: PlaylistItemId): Promise<void> {
      await db.execute("DELETE FROM playlist_items WHERE id = ?", [id])
      await db.save()
    },

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM playlist_items")
      await db.save()
    },
  }
}
