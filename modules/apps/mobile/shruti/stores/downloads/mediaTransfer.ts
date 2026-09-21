import { downloadMedia } from "@usecases/downloads/downloadMedia.js"
import type { TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"
import type { Shruti } from "@shruti/shruti.js"

export interface MediaTransferInput {
  readonly app: Shruti
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
  const { app, trackId, path } = input
  return downloadMedia(
    { trackId, path, candidates: input.candidates },
    {
      mediaItems: app.repositories().mediaItems,
      unitOfWork: app.repositories().unitOfWork,
      transfer: (url, onProgress, signal) =>
        app.mediaDownloader.download(
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
