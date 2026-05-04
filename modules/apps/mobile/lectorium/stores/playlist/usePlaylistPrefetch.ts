import { useLectorium } from "@lectorium/lectorium.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistEntry } from "@lib/application/listPlaylistTracks.js"

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

  async function prefetchTrack(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const track = await repos.tracks.getById(trackId)
      const variant = track?.variants.find((v) => v.audio) ?? null
      if (variant?.audio) {
        useDownloadStore().prefetch(trackId, variant.audio.path)
      }
    } catch (err) {
      console.error("[playlist] prefetch failed", err)
    }
    void prefetchTranscripts(trackId)
  }

  async function prefetchTranscripts(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const languages = await repos.transcripts.availableLanguages(trackId)
      for (const lang of languages) {
        repos.transcripts.get(trackId, lang).catch(() => {})
      }
    } catch (err) {
      console.error("[playlist] transcript prefetch failed", err)
    }
  }

  function prefetchAll(entries: readonly PlaylistEntry[]): void {
    const downloads = useDownloadStore()
    for (const { track } of entries) {
      const variant = track.variants.find((v) => v.audio)
      if (variant?.audio) {
        downloads.prefetch(track.id, variant.audio.path)
      }
      void prefetchTranscripts(track.id)
    }
  }

  return { prefetchTrack, prefetchAll }
}
