import { nanoid } from "nanoid"
import type { IDatabase } from "@ports/app/index.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { MediaItemRow } from "@lib/persistence/user"
import { rowToMediaItem } from "./rowMappers.js"

const newMediaItemId = (): string => `media_${nanoid(12)}`

export function createSqlMediaItemRepository(db: IDatabase): IMediaItemRepository {
  return {
    async getByTrack(trackId: TrackId): Promise<MediaItem | null> {
      const rows = await db.query<MediaItemRow>(
        "SELECT * FROM media_items WHERE track_id = ? LIMIT 1",
        [trackId]
      )
      return rows[0] ? rowToMediaItem(rows[0]) : null
    },

    async listReady(): Promise<readonly MediaItem[]> {
      const rows = await db.query<MediaItemRow>(
        "SELECT * FROM media_items WHERE state = 'ready' ORDER BY created_at DESC"
      )
      return rows.map(rowToMediaItem)
    },

    async upsert(
      trackId: TrackId,
      state: MediaItemState,
      localPath: string | null
    ): Promise<MediaItem> {
      const existing = await this.getByTrack(trackId)
      if (existing) {
        await db.execute("UPDATE media_items SET state = ?, local_path = ? WHERE id = ?", [
          state,
          localPath,
          existing.id,
        ])
        await db.save()
        return { ...existing, state, localPath }
      }
      const id = newMediaItemId()
      const now = Date.now()
      await db.execute(
        `INSERT INTO media_items (id, track_id, state, local_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, trackId, state, localPath, now]
      )
      await db.save()
      return { id, trackId, state, localPath, createdAt: now }
    },

    async deleteByTrack(trackId: TrackId): Promise<void> {
      await db.execute("DELETE FROM media_items WHERE track_id = ?", [trackId])
      await db.save()
    },

    async deleteById(id: MediaItemId): Promise<void> {
      await db.execute("DELETE FROM media_items WHERE id = ?", [id])
      await db.save()
    },

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM media_items")
      await db.save()
    },
  }
}
