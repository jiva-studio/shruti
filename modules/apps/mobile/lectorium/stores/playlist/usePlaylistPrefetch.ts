import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { useTranscriptPrefetch } from "@lectorium/stores/downloads/useTranscriptPrefetch.js"
import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistEntry } from "@lib/application/listPlaylistTracks.js"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Cap on parallel per-track transcript prefetch chains during a
 * playlist fan-out. Each chain itself fetches every advertised language
 * sequentially, so 3 in flight gives the device useful concurrency
 * without burying the CDN under a 50-deep request burst on a long
 * playlist.
 */
const TRANSCRIPT_PREFETCH_CONCURRENCY = 3

export interface PlaylistPrefetchReturn {
  /** Audio + transcripts for a single track. Fire-and-forget under the hood. */
  prefetchTrack(trackId: TrackId): Promise<void>
  /** Audio + transcripts for every entry in the given list. Fire-and-forget. */
  prefetchAll(entries: readonly PlaylistEntry[]): void
}

/**
 * Background prefetch helpers for the playlist surface. Pulls track
 * audio into the offline cache (delegated to `useDownloadStore`) and
 * pre-warms every advertised transcript JSON, so the Transcript dialog
 * renders instantly when the user opens it later.
 *
 * All errors are logged at warn-level rather than re-thrown — a missing
 * transcript or a network blip during prefetch is non-fatal; the
 * download store keeps its own retry surface and the dialog has its
 * own empty/error state.
 */
export function usePlaylistPrefetch(): PlaylistPrefetchReturn {
  const app = useLectorium()
  // Lazy — `useTranscriptPrefetch` reads `useLectorium`, must not run
  // until the composition root is ready.
  let transcriptPrefetch: ReturnType<typeof useTranscriptPrefetch> | null = null
  function transcripts(): ReturnType<typeof useTranscriptPrefetch> {
    if (!transcriptPrefetch) transcriptPrefetch = useTranscriptPrefetch()
    return transcriptPrefetch
  }

  async function prefetchTrack(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const track = await repos.tracks.getById(trackId)
      const variant = track?.variants.find((v) => v.audio) ?? null
      if (variant?.audio) {
        useDownloadStore().prefetch(trackId, variant.audio.path)
      } else {
        // No audio to download. `add()` optimistically set "downloading"
        // before this resolved; without clearing it the row spins forever
        // (nothing ever calls `ensureDownloaded` to flip the state).
        useDownloadStore().clearStartingDownload(trackId)
      }
    } catch (err) {
      console.error("[playlist] prefetch failed", err)
    }
    // Delegate to the shared transcript prefetcher so the playlist path
    // gets the same `useServerFallback` CDN rotation the audio-success
    // path uses. Previously it called `repos.transcripts.get` directly
    // and skipped fallback entirely.
    void transcripts().prefetchForTrack(trackId)
  }

  function prefetchAll(entries: readonly PlaylistEntry[]): void {
    const downloads = useDownloadStore()
    const trackIds: TrackId[] = []
    for (const { track } of entries) {
      const variant = track.variants.find((v) => v.audio)
      if (variant?.audio) {
        downloads.prefetch(track.id, variant.audio.path)
      }
      trackIds.push(track.id)
    }
    void runWithConcurrency(trackIds, TRANSCRIPT_PREFETCH_CONCURRENCY, (id) =>
      transcripts().prefetchForTrack(id)
    )
  }

  return { prefetchTrack, prefetchAll }
}

/**
 * Run `work(item)` over `items` with at most `limit` in flight. Used to
 * cap the playlist's per-track transcript fan-out instead of dispatching
 * all N tasks instantly.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  const slots = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        await work(items[idx])
      } catch {
        // prefetchForTrack already logs at warn-level internally.
      }
    }
  }
  await Promise.all(Array.from({ length: slots }, () => worker()))
}
