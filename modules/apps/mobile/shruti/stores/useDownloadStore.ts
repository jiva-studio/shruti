import { defineStore } from "pinia"
import { ref } from "vue"
import { downloadMedia } from "@lib/application/downloadMedia.js"
import { removeDownloadedMedia } from "@lib/application/removeDownloadedMedia.js"
import type { TrackId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"

export type DownloadState = "idle" | "downloading" | "completed" | "failed"

/**
 * Per-track media download state. The source of truth is the user DB
 * (`IMediaItemRepository`) — this store hydrates once from `listReady()`
 * so the "downloaded" indicator survives app relaunches, and in-flight
 * signals are tracked in memory for the duration of a session.
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useShruti()

  const states = ref<Map<TrackId, DownloadState>>(new Map())
  // Per-track download progress 0..100. Populated only while a download
  // is in flight; cleared on completed/failed/idle/remove.
  const progress = ref<Map<TrackId, number>>(new Map())
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
    } catch (err) {
      console.error("[downloads] hydrate failed:", err)
    }
  }

  /**
   * Ensure the track's audio is cached locally. Returns the local URL
   * (blob: on web, file:// on native). Concurrent calls for the same
   * track share one in-flight download. Returns `null` on failure.
   */
  async function ensureDownloaded(trackId: TrackId, remoteUrl: string): Promise<string | null> {
    const existing = inFlight.get(trackId)
    if (existing) return existing

    const task = (async (): Promise<string | null> => {
      try {
        const cached = await app.mediaDownloader.resolveLocalUrl(remoteUrl)
        if (cached) {
          setState(trackId, "completed")
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
    await removeDownloadedMedia(
      { trackId, remoteUrl },
      {
        mediaItems: app.repositories().mediaItems,
        deleteLocal: (url) => app.mediaDownloader.delete(url),
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
    getState,
    getProgress,
    hydrate,
    ensureDownloaded,
    prefetch,
    remove,
  }
})
