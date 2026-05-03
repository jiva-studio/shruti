import { defineStore } from "pinia"
import { ref } from "vue"
import { downloadMedia } from "@lib/application/downloadMedia.js"
import { downloadTranscripts } from "@lib/application/downloadTranscripts.js"
import { removeDownloadedMedia } from "@lib/application/removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "@lib/application/removeDownloadedTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"

export type DownloadState = "idle" | "downloading" | "completed" | "failed"

/**
 * Per-track media download state. The source of truth is the user DB
 * (`IMediaItemRepository`) — this store hydrates once from `listReady()`
 * so the "downloaded" indicator survives app relaunches, and in-flight
 * signals are tracked in memory for the duration of a session.
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useLectorium()

  const states = ref<Map<TrackId, DownloadState>>(new Map())
  // Per-track download progress 0..100. Populated only while a download
  // is in flight; cleared on completed/failed/idle/remove.
  const progress = ref<Map<TrackId, number>>(new Map())
  // Set when the most recent `hydrate()` couldn't read the user DB
  // (schema drift, db locked, plugin error). Without this, the UI
  // showed every track as "not downloaded" and the user had no signal
  // why. The Welcome screen / Settings can render a banner from this.
  const hydrationError = ref<string | null>(null)
  const inFlight = new Map<TrackId, Promise<string | null>>()
  let hydrated = false

  function setState(trackId: TrackId, state: DownloadState): void {
    const next = new Map(states.value)
    next.set(trackId, state)
    states.value = next
    if (state !== "downloading") {
      const p = new Map(progress.value)
      if (p.delete(trackId)) progress.value = p
    }
  }

  function setProgress(trackId: TrackId, pct: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    if (progress.value.get(trackId) === clamped) return
    const next = new Map(progress.value)
    next.set(trackId, clamped)
    progress.value = next
  }

  function getState(trackId: TrackId): DownloadState {
    return states.value.get(trackId) ?? "idle"
  }

  function getProgress(trackId: TrackId): number {
    return progress.value.get(trackId) ?? 0
  }

  /**
   * Rebuild the reactive state map from the user DB. Called once on
   * first use; idempotent so Home / Search / Settings can all request
   * it defensively without re-hitting SQLite.
   */
  async function hydrate(): Promise<void> {
    if (hydrated) return
    try {
      const repo = app.repositories().mediaItems
      // Recover rows the previous session left at "downloading" because
      // the app was force-closed or crashed mid-transfer. Without this
      // the Download button stays locked-out (downloadMedia rejects with
      // already-in-progress) until the user wipes data.
      await repo.failStaleDownloads()
      const ready = await repo.listReady()
      const next = new Map<TrackId, DownloadState>()
      for (const item of ready) next.set(item.trackId, "completed")
      states.value = next
      hydrated = true
      hydrationError.value = null
    } catch (err) {
      console.error("[downloads] hydrate failed:", err)
      hydrationError.value = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Eagerly cache every advertised transcript for the track so the
   * Transcript dialog can render offline. Fire-and-forget — transcript
   * JSON is kilobytes; the audio download (megabytes) is the user-visible
   * "save for offline" milestone, so we don't block its completion on the
   * transcript leg. Failures are logged at warn-level (not swallowed) so
   * they show up when QA inspects the device console.
   */
  function downloadTranscriptsForTrack(trackId: TrackId): void {
    void (async () => {
      try {
        const repos = app.repositories()
        const result = await downloadTranscripts(
          { trackId },
          {
            transcripts: repos.transcripts,
            // `transcripts.get(...)` already routes through the
            // `IRemoteFilesStorage.get(url)` cache, so a successful
            // call leaves the JSON pinned on disk. We don't need a
            // dedicated repo method for "prefetch".
            transfer: async (id, language) => {
              await repos.transcripts.get(id, language)
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

  /**
   * Ensure the track's audio is cached locally. Returns the local URL
   * (blob: on web, file:// on native). Concurrent calls for the same
   * track share one in-flight download. Returns `null` on failure.
   *
   * On audio-success the transcript JSON for every advertised language
   * is also fetched in the background. The audio result isn't gated on
   * the transcript leg — opening a downloaded track for playback must
   * not wait on a 50KB JSON file behind a kilobyte-counter spinner.
   */
  async function ensureDownloaded(trackId: TrackId, remoteUrl: string): Promise<string | null> {
    const existing = inFlight.get(trackId)
    if (existing) return existing

    const task = (async (): Promise<string | null> => {
      try {
        const cached = await app.mediaDownloader.resolveLocalUrl(remoteUrl)
        if (cached) {
          setState(trackId, "completed")
          // Even when audio is already on disk, make sure transcripts
          // are too — the user might have saved offline before the
          // transcript-prefetch feature shipped, so this self-heals.
          downloadTranscriptsForTrack(trackId)
          return cached
        }
        setProgress(trackId, 0)
        setState(trackId, "downloading")
        const result = await downloadMedia(
          { trackId, remoteUrl },
          {
            mediaItems: app.repositories().mediaItems,
            transfer: (url, onProgress) =>
              app.mediaDownloader.download(url, (received, total) => {
                onProgress?.(received, total)
              }),
          },
          (pct) => setProgress(trackId, pct)
        )
        if (result.ok) {
          setState(trackId, "completed")
          downloadTranscriptsForTrack(trackId)
          return result.value.localPath
        }
        setState(trackId, "failed")
        return null
      } catch (err) {
        console.error(`[downloads] failed for ${trackId}:`, err)
        setState(trackId, "failed")
        return null
      } finally {
        inFlight.delete(trackId)
      }
    })()

    inFlight.set(trackId, task)
    return task
  }

  /**
   * Fire-and-forget wrapper for "add to playlist" flows that don't want to
   * block the UI on the download result.
   */
  function prefetch(trackId: TrackId, remoteUrl: string): void {
    void ensureDownloaded(trackId, remoteUrl)
  }

  async function remove(trackId: TrackId, remoteUrl: string): Promise<void> {
    const repos = app.repositories()
    await removeDownloadedMedia(
      { trackId, remoteUrl },
      {
        mediaItems: repos.mediaItems,
        deleteLocal: (url) => app.mediaDownloader.delete(url),
      }
    )
    // Drop transcript JSON files alongside the audio. We resolve the
    // bucket path from the content DB, build the same URL the HTTP
    // transcript repo uses (`storagePublicUrl.get(path)`), and ask the
    // shared `IRemoteFilesStorage` to evict it. Failures are tolerated
    // per-language inside the use case — orphan cache entries are
    // harmless and a Settings → Clear cache sweep will reclaim them.
    await removeDownloadedTranscripts(
      { trackId },
      {
        transcripts: repos.transcripts,
        deleteLocal: async (id, language) => {
          const path = await repos.tracks.getTranscriptPath(id, language)
          if (!path) return
          const url = app.storagePublicUrl.get(path)
          await app.filesStorage.delete(url)
        },
      }
    )
    const nextStates = new Map(states.value)
    nextStates.delete(trackId)
    states.value = nextStates
    const nextProgress = new Map(progress.value)
    if (nextProgress.delete(trackId)) progress.value = nextProgress
  }

  return {
    states,
    progress,
    hydrationError,
    getState,
    getProgress,
    hydrate,
    ensureDownloaded,
    prefetch,
    remove,
  }
})
