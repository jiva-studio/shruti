import type { TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { downloadMedia } from "./downloadMedia.js"
import type { DownloadPlatform } from "./downloadPorts.js"

export interface MediaTransferInput {
  readonly platform: DownloadPlatform
  readonly trackId: TrackId
  readonly path: string
  readonly candidates: readonly CdnServer[]
  /** Called with the rounded percentage, only when the byte total is known. */
  readonly onProgress: (pct: number) => void
  /** Called for every chunk, whether or not a percentage can be computed. */
  readonly onByte: () => void
}

/**
 * Move the bytes: the use case's CDN walk over the platform downloader.
 *
 * The two callbacks are separate on purpose. A server that omits
 * Content-Length reports no percentage at all, and a transfer that is
 * delivering must never look stalled to the watch above.
 */
export function startMediaTransfer(input: MediaTransferInput): ReturnType<typeof downloadMedia> {
  const { platform, trackId, path } = input
  const repos = platform.repositories()
  return downloadMedia(
    { trackId, path, candidates: input.candidates },
    {
      mediaItems: repos.mediaItems,
      unitOfWork: repos.unitOfWork,
      schedule: platform.schedule,
      transfer: (url, onProgress, signal) =>
        platform.files.download(
          url,
          (received, total) => {
            input.onByte()
            onProgress?.(received, total)
          },
          signal
        ),
    },
    input.onProgress
  )
}
