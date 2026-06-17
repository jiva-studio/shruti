import type { TrackId } from "@lib/domain/core.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import { err, ok, type Result } from "@kit/core"

export interface RemoveDownloadedMediaInput {
  readonly trackId: TrackId
  readonly remoteUrl: string
}

export type RemoveMediaTransferFn = (url: string) => Promise<void>

export interface RemoveDownloadedMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly deleteLocal: RemoveMediaTransferFn
}

export type RemoveDownloadedMediaError = "not-downloaded" | "delete-local-failed"

/**
 * Remove a track's downloaded media from disk and clear its state
 * record. Returns `not-downloaded` when nothing was cached for the
 * track — the UI can silently no-op.
 *
 * The DB and filesystem can't share a transaction, so we order the
 * steps so a crash at any point leaves the system retry-recoverable
 * instead of stuck claiming a missing file is still cached:
 *   1. Demote the row to "failed" with localPath=null. Hydrate filters
 *      to state="ready", so the UI immediately stops showing the track
 *      as downloaded.
 *   2. Delete the bytes. Tolerate "already gone" inside the deleteLocal
 *      adapter — happens after a partial previous attempt or a
 *      user-initiated cache clear.
 *   3. Drop the row.
 *
 * If step 2 throws, step 3 is skipped: dropping the row would leave an
 * orphan file with no way to retry the deletion. The row stays in
 * (failed, localPath=null), so the next removeDownloadedMedia call
 * picks up at step 2.
 *
 * Re-running this on a row already in step 1 is idempotent.
 */
export async function removeDownloadedMedia(
  input: RemoveDownloadedMediaInput,
  deps: RemoveDownloadedMediaDeps
): Promise<Result<void, RemoveDownloadedMediaError>> {
  const existing = await deps.mediaItems.getByTrack(input.trackId)
  if (!existing) return err("not-downloaded")

  if (existing.state !== "failed" || existing.localPath !== null) {
    await deps.mediaItems.upsert(input.trackId, "failed", null)
  }

  try {
    await deps.deleteLocal(input.remoteUrl)
  } catch {
    // Leave the row in (failed, null) so a future call retries from
    // step 2. Dropping the row would orphan the file.
    return err("delete-local-failed")
  }

  await deps.mediaItems.deleteByTrack(input.trackId)
  return ok(undefined)
}
