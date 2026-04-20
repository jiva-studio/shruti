import { defineStore } from "pinia"
import { ref } from "vue"
import type { TrackId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"

export type DownloadState = "idle" | "downloading" | "completed" | "failed"

/**
 * Per-track media download state. `filesStorage` itself caches the payload —
 * this store exists only so the UI can reactively show a spinner / checkmark
 * while a download is in flight. The actual bytes live on the platform cache
 * (Cache API on web, Filesystem.Cache on Capacitor).
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useLectorium()

  const states = ref<Map<TrackId, DownloadState>>(new Map())
  const inFlight = new Map<TrackId, Promise<string | null>>()

  function setState(trackId: TrackId, state: DownloadState): void {
    const next = new Map(states.value)
    next.set(trackId, state)
    states.value = next
  }

  function getState(trackId: TrackId): DownloadState {
    return states.value.get(trackId) ?? "idle"
  }

  /**
   * Ensure the track's audio is cached locally. Returns the local URL
   * (blob: on web, file:// on native). Idempotent — concurrent calls for
   * the same track share one in-flight download. Returns `null` on failure.
   */
  async function ensureDownloaded(
    trackId: TrackId,
    remoteUrl: string
  ): Promise<string | null> {
    const existing = inFlight.get(trackId)
    if (existing) return existing

    const task = (async (): Promise<string | null> => {
      const already = await app.filesStorage.has(remoteUrl)
      if (already) {
        setState(trackId, "completed")
        try {
          return await app.filesStorage.get(remoteUrl)
        } catch {
          return null
        }
      }
      setState(trackId, "downloading")
      try {
        const localUrl = await app.filesStorage.get(remoteUrl)
        setState(trackId, "completed")
        return localUrl
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

  return {
    states,
    getState,
    ensureDownloaded,
    prefetch,
  }
})
