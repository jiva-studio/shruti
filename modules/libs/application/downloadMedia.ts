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
 *
 * The optional `onProgress` is forwarded down to the platform downloader
 * so the UI can render a real radial gauge. `total` may be ≤ 0 when the
 * server omits Content-Length — callers must guard against that.
 */
export type MediaTransferFn = (
  url: string,
  onProgress?: (received: number, total: number) => void
) => Promise<string>

export interface DownloadMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly transfer: MediaTransferFn
}

export type DownloadMediaError =
  | "already-in-progress"
  | "transfer-failed"
  | "persist-failed"

/**
 * Download a track's media and persist the lifecycle in the user DB
 * so the UI can recover the "ready" indicator after a relaunch. The
 * state machine is pending → downloading → ready / failed, serialised
 * through `IMediaItemRepository.upsert`.
 *
 * Optional `onProgress(pct)` reports the rounded percentage 0..100 only
 * when the byte total is known.
 */
export async function downloadMedia(
  input: DownloadMediaInput,
  deps: DownloadMediaDeps,
  onProgress?: (pct: number) => void
): Promise<Result<MediaItem, DownloadMediaError>> {
  const existing = await deps.mediaItems.getByTrack(input.trackId)
  if (existing?.state === "downloading") return err("already-in-progress")
  if (existing?.state === "ready" && existing.localPath) {
    return ok(existing)
  }

  await deps.mediaItems.upsert(input.trackId, "downloading", null)

  let localUrl: string
  try {
    localUrl = await deps.transfer(input.remoteUrl, (received, total) => {
      if (total > 0) onProgress?.(Math.round((received / total) * 100))
    })
  } catch {
    // Best-effort mark "failed"; if the upsert itself rejects we don't
    // want a second exception masking the original transfer failure.
    try {
      await deps.mediaItems.upsert(input.trackId, "failed", null)
    } catch {
      /* swallow — surfacing the transfer error matters more */
    }
    return err("transfer-failed")
  }

  // Bytes are on disk. The DB write is a separate failure mode (locked,
  // disk full, schema drift) and must not be conflated with a transfer
  // failure — Retry has different semantics for the two: a persist
  // retry should not re-download megabytes that are already cached.
  try {
    const saved = await deps.mediaItems.upsert(input.trackId, "ready", localUrl)
    return ok(saved)
  } catch {
    return err("persist-failed")
  }
}
