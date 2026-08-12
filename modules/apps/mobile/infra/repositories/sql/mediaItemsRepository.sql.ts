import type { IDatabase } from "@ports/app/index.js"
import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { MediaAudioKind, MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { ITransaction, IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { MediaItemRow } from "@lib/persistence/user"
import { mutate, queryMany, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToMediaItem } from "./rowMappers.js"

const newMediaItemId = createIdGenerator("media")

/**
 * Every write goes through the injected {@link IUnitOfWork} rather than a bare
 * `mutate`.
 *
 * `mutate` is `execute` + `save`, and `execute` deliberately bypasses the
 * adapters' transaction queue (repos call it from inside a transaction
 * callback, so queueing it would dead-lock — see
 * `useCapacitorSqlPersistence.ts`). The consequence is that a bare write
 * issued while an unrelated transaction is open joins that transaction on the
 * single shared connection and is discarded when it rolls back (#1494). The
 * download pipeline writes on its own schedule — a transfer finishing, a stall
 * timer firing, a launch-time reconcile — none of it synchronised with a sync
 * pull's transaction window, so the overlap is routine.
 *
 * Losing one of these is bounded rather than silent: the "downloading" claim
 * IS journaled, so a lost terminal write leaves the row at "downloading" and
 * the next launch demotes it and re-adopts the file from disk. The residue is
 * a track that left the catalog keeping the demotion, plus the window before
 * that reconcile lands.
 *
 * `upsert` additionally needs the transaction for its own sake: it reads the
 * existing row and writes conditionally on it, and that pair is what makes
 * `downloadMedia`'s check-and-claim of the "downloading" slot atomic against a
 * second tap. That caller opens the transaction itself and passes the handle
 * down, so the claim and the row it decides stay one block.
 */
export function createSqlMediaItemRepository(
  db: IDatabase,
  unitOfWork: IUnitOfWork
): IMediaItemRepository {
  async function getByTrack(trackId: TrackId, kind: MediaAudioKind): Promise<MediaItem | null> {
    return queryOne<MediaItemRow, MediaItem>(
      db,
      "SELECT * FROM media_items WHERE track_id = ? AND kind = ? LIMIT 1",
      [trackId, kind],
      rowToMediaItem
    )
  }

  return {
    async getByTrack(
      trackId: TrackId,
      kind: MediaAudioKind = "original"
    ): Promise<MediaItem | null> {
      return getByTrack(trackId, kind)
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
      kind: MediaAudioKind = "original",
      tx?: ITransaction
    ): Promise<MediaItem> {
      return unitOfWork.run(async () => {
        const existing = await getByTrack(trackId, kind)
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
      }, tx)
    },

    async markEvictPending(trackId: TrackId): Promise<void> {
      // Only a file that exists can be owed back. An UPDATE (never an insert)
      // so a track with no cache row records no debt, and so a row deleted by
      // an eviction that raced this write stays deleted.
      await unitOfWork.run(() =>
        mutate(
          db,
          "UPDATE media_items SET evict_pending = 1 WHERE track_id = ? AND state = 'ready'",
          [trackId]
        )
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
      await unitOfWork.run(() =>
        mutate(db, "DELETE FROM media_items WHERE track_id = ?", [trackId])
      )
    },

    async deleteById(id: MediaItemId): Promise<void> {
      await unitOfWork.run(() => mutate(db, "DELETE FROM media_items WHERE id = ?", [id]))
    },

    async clearAll(): Promise<void> {
      await unitOfWork.run(() => mutate(db, "DELETE FROM media_items"))
    },

    async failStaleDownloads(): Promise<readonly MediaItem[]> {
      // Read before writing: the demotion is what makes the rows retryable,
      // and the caller needs to know which ones it hit so it can ask the disk
      // whether the transfer finished behind the app's back. The stored
      // `local_path` is deliberately NOT part of that answer — on iOS it is
      // anchored to a container UUID an app update invalidates, which is why
      // the native side re-resolves the path from the file's key instead.
      //
      // Read and demotion in ONE transaction: a download finishing between the
      // two would otherwise have its fresh "ready" row demoted without being
      // reported back, so the reconcile that would have re-adopted it never
      // hears about it.
      return unitOfWork.run(async () => {
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
      })
    },
  }
}
