import type { TrackId } from "@lib/domain/core.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface RemoveDownloadedMediaInput {
  readonly trackId: TrackId
  readonly remoteUrl: string
}

export type RemoveMediaTransferFn = (url: string) => Promise<void>

export interface RemoveDownloadedMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly deleteLocal: RemoveMediaTransferFn
}

export type RemoveDownloadedMediaError = "not-downloaded"

/**
 * Remove a track's downloaded media from disk and clear its state
 * record. Returns `not-downloaded` when nothing was cached for the
 * track — the UI can silently no-op.
 */
export async function removeDownloadedMedia(
  input: RemoveDownloadedMediaInput,
  deps: RemoveDownloadedMediaDeps
): Promise<Result<void, RemoveDownloadedMediaError>> {
  const existing = await deps.mediaItems.getByTrack(input.trackId)
  if (!existing) return err("not-downloaded")
  await deps.deleteLocal(input.remoteUrl)
  await deps.mediaItems.deleteByTrack(input.trackId)
  return ok(undefined)
}
