import type { TrackId } from "@lib/domain/core.js"
import {
  clearMediaCache,
  listDownloadedTrackIds,
  measureDownloadedBytes,
  recoverDownloadLedger,
  type RecoveredLedger,
} from "@usecases/downloads/downloadLedger.js"
import type { DownloadPlatform, StallWatch } from "@usecases/downloads/downloadPorts.js"
import {
  downloadTranscripts,
  type DownloadTranscriptsInput,
} from "@usecases/downloads/downloadTranscripts.js"
import { useShruti, type Shruti } from "@shruti/shruti.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

export interface DownloadUseCases {
  /** The downloader, the repositories and the active CDN, as the download flow drives them. */
  platform(startStallWatch: () => StallWatch): DownloadPlatform
  recoverLedger(): Promise<RecoveredLedger>
  listDownloadedTrackIds(): Promise<readonly TrackId[]>
  measureDownloadedBytes(
    sizeOf: (filesize: number | null | undefined) => number
  ): Promise<Map<TrackId, number>>
  clearMediaCache(): Promise<void>
  /** Fetch a track's transcripts, each through `tryServers` so a dead CDN falls through. */
  downloadTranscripts(
    input: DownloadTranscriptsInput,
    tryServers: <T>(attempt: () => Promise<T>) => Promise<T | null>
  ): ReturnType<typeof downloadTranscripts>
}

/** The download use cases, bound to the Shruti adapters. Repositories are
 *  resolved per call, so each throws until the databases are open. */
export function useDownloadUseCases(app: Shruti = useShruti()): DownloadUseCases {
  const repos = () => app.repositories()
  return {
    platform: (startStallWatch) => ({
      files: app.mediaDownloader,
      repositories: repos,
      activeServer: () => app.activeServer.value,
      promoteServer: (server) => app.setActiveServer(server),
      deleteTranscriptFile: (path) => app.filesStorage.delete(app.storagePublicUrl.get(path)),
      loadedQueueItem: async () => {
        const queue = await app.audioPlayer.getQueueState().catch((err: unknown) => {
          reportError("downloads", err)
          return null
        })
        return queue?.currentItemId ?? null
      },
      isOffline: () => typeof navigator !== "undefined" && navigator.onLine === false,
      startStallWatch,
      schedule: (run, delayMs) => {
        const id = setTimeout(run, delayMs)
        return () => clearTimeout(id)
      },
    }),
    recoverLedger: () => recoverDownloadLedger(repos()),
    listDownloadedTrackIds: () => listDownloadedTrackIds(repos()),
    measureDownloadedBytes: (sizeOf) => measureDownloadedBytes(repos(), sizeOf),
    clearMediaCache: () =>
      clearMediaCache({
        deleteAllFiles: () => app.filesStorage.clearAll(),
        mediaItems: () => repos().mediaItems,
      }),
    downloadTranscripts: (input, tryServers) => {
      const transcripts = repos().transcripts
      return downloadTranscripts(input, {
        transcripts,
        transfer: async (id, language) => {
          const outcome = await tryServers(() => transcripts.get(id, language))
          if (outcome === null) {
            throw new Error(`transcript fetch failed on every CDN: ${id} / ${language}`)
          }
        },
      })
    },
  }
}
