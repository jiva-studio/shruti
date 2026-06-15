import type { IDatabase } from "@ports/app/index.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { MediaAudioKind, MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { MediaItemRow } from "@lib/persistence/user"
import { mutate, queryMany, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToMediaItem } from "./rowMappers.js"

const newMediaItemId = createIdGenerator("media")

export function createSqlMediaItemRepository(db: IDatabase): IMediaItemRepository {
  return {
    async getByTrack(
      trackId: TrackId,
      kind: MediaAudioKind = "original"
    ): Promise<MediaItem | null> {
      return queryOne<MediaItemRow, MediaItem>(
        db,
        "SELECT * FROM media_items WHERE track_id = ? AND kind = ? LIMIT 1",
        [trackId, kind],
        rowToMediaItem
      )
    },

    async listReady(): Promise<readonly MediaItem[]> {
      return queryMany<MediaItemRow, MediaItem>(
        db,
        "SELECT * FROM media_items WHERE state = 'ready' ORDER BY created_at DESC",
        [],
        rowToMediaItem
      )
    },

    async upsert(
      trackId: TrackId,
      state: MediaItemState,
      localPath: string | null,
      kind: MediaAudioKind = "original"
    ): Promise<MediaItem> {
      const existing = await this.getByTrack(trackId, kind)
      if (existing) {
        await mutate(db, "UPDATE media_items SET state = ?, local_path = ? WHERE id = ?", [
          state,
          localPath,
          existing.id,
        ])
        return { ...existing, state, localPath }
      }
      const id = newMediaItemId()
      const now = Date.now()
      await mutate(
        db,
        `INSERT INTO media_items (id, track_id, kind, state, local_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, trackId, kind, state, localPath, now]
      )
      return { id, trackId, kind, state, localPath, createdAt: now }
    },

    async deleteByTrack(trackId: TrackId): Promise<void> {
      await mutate(db, "DELETE FROM media_items WHERE track_id = ?", [trackId])
    },

    async deleteById(id: MediaItemId): Promise<void> {
      await mutate(db, "DELETE FROM media_items WHERE id = ?", [id])
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM media_items")
    },

    async failStaleDownloads(): Promise<void> {
      await mutate(
        db,
        "UPDATE media_items SET state = 'failed', local_path = NULL WHERE state = 'downloading'"
      )
    },
  }
}
