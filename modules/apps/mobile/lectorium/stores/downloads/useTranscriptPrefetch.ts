import { downloadTranscripts } from "@usecases/downloads/downloadTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { useWantedTranscriptLanguages } from "@lectorium/composables/useWantedTranscriptLanguages.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useServerFallback } from "./useServerFallback.js"

export interface TranscriptPrefetchReturn {
  /**
   * Cache the track's transcript in the languages the user reads (see
   * `useWantedTranscriptLanguages`) so the Transcript dialog can render
   * offline. Transcript JSON is kilobytes; the audio download (megabytes)
   * is the user-visible "save for offline" milestone, so callers should
   * typically still treat this as fire-and-forget
   * (`void prefetchForTrack(id)`). The returned promise is exposed so
   * concurrency-capped fan-outs (e.g. playlist prefetch over N tracks) can
   * await completion of each slot before starting the next. Failures are
   * logged at warn-level (not swallowed) so they show up when QA inspects
   * the device console.
   */
  prefetchForTrack(trackId: TrackId): Promise<void>
  /**
   * Re-run the prefetch over every track already saved for offline. Called
   * when the wanted-language set WIDENS, so lectures downloaded under the
   * old set catch up instead of being stuck without the language the user
   * just chose. Cheap on the languages already on disk — the transfer
   * resolves from the local file and no request leaves the device.
   */
  backfillDownloaded(): Promise<void>
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
  const wanted = useWantedTranscriptLanguages()

  async function prefetchForTrack(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const result = await downloadTranscripts(
        // Until the persisted selection is back we don't know what the user
        // reads, and guessing narrow would silently skip a language; the use
        // case reads an absent list as "every advertised language".
        { trackId, languages: wanted.ready.value ? wanted.languages.value : undefined },
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
  }

  async function backfillDownloaded(): Promise<void> {
    let ready: readonly { readonly trackId: TrackId }[]
    try {
      ready = await app.repositories().mediaItems.listReady()
    } catch (err) {
      console.warn("[downloads] transcript backfill could not list saved tracks:", err)
      return
    }
    // Sequential on purpose: this runs right after a settings change, and a
    // library of saved lectures would otherwise fan out into a request burst
    // against the CDN for no gain (each transcript is a few kilobytes).
    for (const item of ready) await prefetchForTrack(item.trackId)
  }

  return { prefetchForTrack, backfillDownloaded }
}
