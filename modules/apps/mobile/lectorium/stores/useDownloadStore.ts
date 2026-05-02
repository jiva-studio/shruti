import { defineStore } from "pinia"
import { ref } from "vue"
import { downloadMedia } from "@lib/application/downloadMedia.js"
import { removeDownloadedMedia } from "@lib/application/removeDownloadedMedia.js"
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
  const inFlight = new Map<TrackId, Promise<string | null>>()
  let hydrated = false

  function setState(trackId: TrackId, state: DownloadState): void {
    const next = new Map(states.value)
    next.set(trackId, state)
    states.value = next
  }

  function getState(trackId: TrackId): DownloadState {
    return states.value.get(trackId) ?? "idle"
  }

  /**
   * Rebuild the reactive state map from the user DB. Called once on
   * first use; idempotent so Home / Search / Settings can all request
   * it defensively without re-hitting SQLite.
   */
  async function hydrate(): Promise<void> {
    if (hydrated) return
    try {
      const ready = await app.repositories().mediaItems.listReady()
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
        setState(trackId, "downloading")
        const result = await downloadMedia(
          { trackId, remoteUrl },
          {
            mediaItems: app.repositories().mediaItems,
            transfer: (url) => app.mediaDownloader.download(url),
          }
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
    const next = new Map(states.value)
    next.delete(trackId)
    states.value = next
  }

  return {
    states,
    getState,
    hydrate,
    ensureDownloaded,
    prefetch,
    remove,
  }
})
