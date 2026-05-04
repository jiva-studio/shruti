import { downloadTranscripts } from "@lib/application/downloadTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useServerFallback } from "./useServerFallback.js"

export interface TranscriptPrefetchReturn {
  /**
   * Eagerly cache every advertised transcript for the track so the
   * Transcript dialog can render offline. Fire-and-forget — transcript
   * JSON is kilobytes; the audio download (megabytes) is the
   * user-visible "save for offline" milestone, so we don't block its
   * completion on the transcript leg. Failures are logged at warn-level
   * (not swallowed) so they show up when QA inspects the device console.
   */
  prefetchForTrack(trackId: TrackId): void
}

/**
 * Per-track transcript prefetch with the same CDN fallback as audio.
 * `repos.transcripts.get()` reads `storagePublicUrl` (which closes over
 * `activeServer`) freshly per call, so `useServerFallback.tryServers`
 * promotes each candidate before invoking the repo and the repo's URL
 * construction tracks the rotation.
 */
export function useTranscriptPrefetch(): TranscriptPrefetchReturn {
  const app = useLectorium()
  const fallback = useServerFallback()

  function prefetchForTrack(trackId: TrackId): void {
    void (async () => {
      try {
        const repos = app.repositories()
        const result = await downloadTranscripts(
          { trackId },
          {
            transcripts: repos.transcripts,
            transfer: async (id, language) => {
              const outcome = await fallback.tryServers(() => repos.transcripts.get(id, language))
              if (outcome === null) {
                throw new Error(`transcript fetch failed on every CDN: ${id} / ${language}`)
              }
            },
          }
        )
        if (!result.ok) {
          console.warn(`[downloads] transcript list failed for ${trackId}: ${result.error}`)
          return
        }
        if (result.value.failed.length > 0) {
          console.warn(
            `[downloads] transcript download partial for ${trackId}; failed langs: ${result.value.failed.join(", ")}`
          )
        }
      } catch (err) {
        console.warn(`[downloads] transcript download crashed for ${trackId}:`, err)
      }
    })()
  }

  return { prefetchForTrack }
}
