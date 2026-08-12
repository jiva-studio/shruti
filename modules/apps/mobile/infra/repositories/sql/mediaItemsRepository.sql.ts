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
        // Landing a fresh file clears the debt: a track that was owed an
        // eviction and has since been downloaded again owes nothing, and a
        // stale flag would have the next sweep delete the new file. Any other
        // transition leaves it — `removeDownloadedMedia` demotes to "failed"
        // BEFORE deleting the bytes, and losing the flag there would strand
        // the file if that delete then throws.
        const settled = state === "ready"
        await mutate(
          db,
          `UPDATE media_items SET state = ?, local_path = ?,
             evict_pending = CASE WHEN ? THEN 0 ELSE evict_pending END
           WHERE id = ?`,
          [state, localPath, settled ? 1 : 0, existing.id]
        )
        return {
          ...existing,
          state,
          localPath,
          evictPending: settled ? false : existing.evictPending,
        }
      }
      const id = newMediaItemId()
      const now = Date.now()
      await mutate(
        db,
        `INSERT INTO media_items (id, track_id, kind, state, local_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, trackId, kind, state, localPath, now]
      )
      return { id, trackId, kind, state, localPath, createdAt: now, evictPending: false }
    },

    async markEvictPending(trackId: TrackId): Promise<void> {
      // Only a file that exists can be owed back. An UPDATE (never an insert)
      // so a track with no cache row records no debt, and so a row deleted by
      // an eviction that raced this write stays deleted.
      await mutate(
        db,
        "UPDATE media_items SET evict_pending = 1 WHERE track_id = ? AND state = 'ready'",
        [trackId]
      )
    },

    async listEvictPending(): Promise<readonly MediaItem[]> {
      return queryMany<MediaItemRow, MediaItem>(
        db,
        "SELECT * FROM media_items WHERE evict_pending = 1 ORDER BY created_at ASC",
        [],
        rowToMediaItem
      )
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

    async failStaleDownloads(): Promise<readonly MediaItem[]> {
      // Read before writing: the demotion is what makes the rows retryable,
      // and the caller needs to know which ones it hit so it can ask the disk
      // whether the transfer finished behind the app's back. The stored
      // `local_path` is deliberately NOT part of that answer — on iOS it is
      // anchored to a container UUID an app update invalidates, which is why
      // the native side re-resolves the path from the file's key instead.
      const stale = await queryMany<MediaItemRow, MediaItem>(
        db,
        "SELECT * FROM media_items WHERE state = 'downloading'",
        [],
        rowToMediaItem
      )
      await mutate(
        db,
        "UPDATE media_items SET state = 'failed', local_path = NULL WHERE state = 'downloading'"
      )
      return stale
    },
  }
}
