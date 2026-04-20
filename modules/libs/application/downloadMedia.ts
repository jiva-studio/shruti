import type { TrackId } from "@lib/domain/core.js"
import type { MediaItem } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface DownloadMediaInput {
  readonly trackId: TrackId
  readonly remoteUrl: string
}

/**
 * Raw byte-transfer callback. The use case is layer-pure — it can't
 * import `@ports/app/IMediaDownloader` — so the caller (typically the
 * download store) passes the adapter-backed transfer as a plain
 * function. Returning the local URL fulfils the use case's contract
 * to persist `localPath` on success.
 */
export type MediaTransferFn = (url: string) => Promise<string>

export interface DownloadMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly transfer: MediaTransferFn
}

export type DownloadMediaError = "already-in-progress" | "transfer-failed"

/**
 * Download a track's media and persist the lifecycle in the user DB
 * so the UI can recover the "ready" indicator after a relaunch. The
 * state machine is pending → downloading → ready / failed, serialised
 * through `IMediaItemRepository.upsert`.
 */
export async function downloadMedia(
  input: DownloadMediaInput,
  deps: DownloadMediaDeps
): Promise<Result<MediaItem, DownloadMediaError>> {
  const existing = await deps.mediaItems.getByTrack(input.trackId)
  if (existing?.state === "downloading") return err("already-in-progress")
  if (existing?.state === "ready" && existing.localPath) {
    return ok(existing)
  }

  await deps.mediaItems.upsert(input.trackId, "downloading", null)

  try {
    const localUrl = await deps.transfer(input.remoteUrl)
    const saved = await deps.mediaItems.upsert(input.trackId, "ready", localUrl)
    return ok(saved)
  } catch {
    await deps.mediaItems.upsert(input.trackId, "failed", null)
    return err("transfer-failed")
  }
}
