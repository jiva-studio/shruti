import { defineStore } from "pinia"
import { ref } from "vue"
import { downloadMedia } from "@lib/application/downloadMedia.js"
import { removeDownloadedMedia } from "@lib/application/removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "@lib/application/removeDownloadedTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
import { promotePreferredServer } from "@shruti/services/preferredServer.js"
import { useServerFallback } from "./downloads/useServerFallback.js"
import { useTranscriptPrefetch } from "./downloads/useTranscriptPrefetch.js"

export type DownloadState = "idle" | "downloading" | "completed" | "failed"

/**
 * Per-track media download state. The source of truth is the user DB
 * (`IMediaItemRepository`) — this store hydrates once from `listReady()`
 * so the "downloaded" indicator survives app relaunches, and in-flight
 * signals are tracked in memory for the duration of a session.
 *
 * CDN rotation (`useServerFallback`) and transcript prefetch
 * (`useTranscriptPrefetch`) are split into composables under
 * `stores/downloads/`. The store keeps the reactive state maps and the
 * `ensureDownloaded` orchestration.
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useShruti()
  const fallback = useServerFallback()
  const transcriptPrefetch = useTranscriptPrefetch()

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
  // Bumped by reset() so an in-flight task started before the wipe
  // cannot write back into the freshly-emptied state maps. Every task
  // captures the epoch at start and gates its state writes on a match.
  let storeEpoch = 0

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
   * Ensure the track's audio is cached locally. Returns the local URL
   * (blob: on web, file:// on native). Concurrent calls for the same
   * track share one in-flight download. Returns `null` on failure.
   *
   * Accepts the storage `path` (full bucket key) rather than a
   * pre-resolved URL so the use case can build a fresh URL per attempt
   * during runtime CDN fallback. Callers must NOT capture a URL once
   * and reuse it: the active CDN can be swapped between calls.
   *
   * On audio-success the transcript JSON for every advertised language
   * is also fetched in the background. The audio result isn't gated on
   * the transcript leg — opening a downloaded track for playback must
   * not wait on a 50KB JSON file behind a kilobyte-counter spinner.
   */
  async function ensureDownloaded(trackId: TrackId, path: string): Promise<string | null> {
    const existing = inFlight.get(trackId)
    if (existing) return existing

    // A "failed" in-memory state means the previous attempt did NOT
    // produce a usable file. The iOS plugin's `resolveLocalUrl` can
    // still return a phantom localUrl in this case (its UserDefaults
    // entry is written at download-start and not cleaned up on
    // failure), which would flip the row to "completed" with zero
    // network bytes. So treat the cache as empty AND proactively
    // delete the native-side mapping for this URL before re-trying.
    const isRetryAfterFailure = states.value.get(trackId) === "failed"

    const taskEpoch = storeEpoch
    const fresh = (): boolean => taskEpoch === storeEpoch
    // Token used so the task's finally only clears the inFlight slot
    // if it is still the one we put there — reset() may have wiped
    // and a newer task may already own this trackId.
    const ownership: { current: Promise<string | null> | null } = { current: null }

    const task = (async (): Promise<string | null> => {
      try {
        // Cache lookup uses the active server's URL; the platform
        // downloader keys by URL pathname, so any previously-downloaded
        // file is still resolvable even if we later swapped CDNs.
        const probeUrl = buildServerUrl(app.activeServer.value, path)
        if (isRetryAfterFailure) {
          // Flip to "downloading" BEFORE the native delete so the spinner
          // renders on the very next frame — the deleteFile round-trip
          // (UserDefaults + filesystem) can run ~50-200ms on iOS, and
          // without this the row keeps the red X during that window,
          // making the retry tap feel unresponsive.
          if (fresh()) {
            setProgress(trackId, 0)
            setState(trackId, "downloading")
          }
          // Best-effort: evict stale native cache before re-downloading.
          // iOS keeps a phantom UserDefaults entry for the URL after a
          // failed download; without this delete, a follow-up probe
          // would hand back a localUrl pointing at nothing.
          await app.mediaDownloader.delete(probeUrl).catch(() => {})
          // Demote any stale "ready" DB row before invoking
          // `downloadMedia`. The use case's cached branch trusts the DB
          // (`state === "ready" && localPath`) without verifying the
          // file is still on disk — so a row left "ready" from a prior
          // session whose file the OS later evicted (iOS /Caches sweep,
          // user-initiated clear) would short-circuit the retry and
          // return success WITHOUT actually transferring any bytes. The
          // user sees the row flip off-failed but no download happens.
          await app
            .repositories()
            .mediaItems.upsert(trackId, "failed", null)
            .catch(() => {})
        } else {
          const cached = await app.mediaDownloader.resolveLocalUrl(probeUrl)
          if (cached) {
            if (fresh()) setState(trackId, "completed")
            // Even when audio is already on disk, make sure transcripts
            // are too — the user might have saved offline before the
            // transcript-prefetch feature shipped, so this self-heals.
            if (fresh()) void transcriptPrefetch.prefetchForTrack(trackId)
            return cached
          }
          // Native cache says the file isn't there. Demote any stale
          // "ready" DB row before invoking downloadMedia for the same
          // reason as the retry branch above — without this, the use
          // case's cached branch trusts a stale "ready" claim and
          // returns success without re-downloading evicted bytes.
          await app
            .repositories()
            .mediaItems.upsert(trackId, "failed", null)
            .catch(() => {})
          if (fresh()) {
            setProgress(trackId, 0)
            setState(trackId, "downloading")
          }
        }
        const result = await downloadMedia(
          { trackId, path, candidates: fallback.candidates() },
          {
            mediaItems: app.repositories().mediaItems,
            unitOfWork: app.repositories().unitOfWork,
            transfer: (url, onProgress) =>
              app.mediaDownloader.download(url, (received, total) => {
                onProgress?.(received, total)
              }),
          },
          (pct) => {
            if (fresh()) setProgress(trackId, pct)
          }
        )
        if (result.ok) {
          if (fresh()) setState(trackId, "completed")
          // Promote the working CDN if it differs from the active
          // server when the download started. Awaited so the
          // transcript prefetch (kicked off below) starts from the
          // updated active server, not the failed one.
          if (fresh()) await promotePreferredServer(app, result.value.server)
          if (fresh()) void transcriptPrefetch.prefetchForTrack(trackId)
          return result.value.mediaItem.localPath
        }
        if (fresh()) setState(trackId, "failed")
        return null
      } catch (err) {
        console.error(`[downloads] failed for ${trackId}:`, err)
        if (fresh()) setState(trackId, "failed")
        return null
      } finally {
        // Only delete our own slot. After a reset() the map was
        // cleared and a newer task may already own this trackId.
        if (inFlight.get(trackId) === ownership.current) inFlight.delete(trackId)
      }
    })()

    ownership.current = task
    inFlight.set(trackId, task)
    return task
  }

  /**
   * Fire-and-forget wrapper for "add to playlist" flows that don't want to
   * block the UI on the download result.
   */
  function prefetch(trackId: TrackId, path: string): void {
    void ensureDownloaded(trackId, path)
  }

  /**
   * Synchronously claim "downloading" state for a track. Used by add-to-
   * playlist so the row paints directly as `downloading` instead of
   * flashing the "added" checkmark while `prefetch` resolves the audio
   * path and `ensureDownloaded` probes the cache. A subsequent
   * `ensureDownloaded` call will either confirm the state, find the file
   * already cached and flip to "completed", or report "failed". The
   * already-cached branch is skipped here so re-adding a downloaded
   * track doesn't visually rewind to "downloading".
   */
  function markStartingDownload(trackId: TrackId): void {
    if (states.value.get(trackId) === "completed") return
    setProgress(trackId, 0)
    setState(trackId, "downloading")
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

  /**
   * Wipe in-memory download state and force a re-hydrate on next access.
   * Used by the "Clear user data" flow in Settings — after the user DB
   * has been emptied, the cached `Map<TrackId, "completed">` would still
   * paint Home/Search rows as offline-ready until the next launch.
   */
  function reset(): void {
    // Bump the epoch so any still-running download task started before
    // this call cannot write into the freshly-emptied maps when it
    // resolves later. We can't abort the platform transfer mid-flight
    // (the downloader port has no AbortSignal yet), so we cancel
    // logically: the task still resolves but its setState/setProgress
    // calls become no-ops.
    storeEpoch += 1
    states.value = new Map()
    progress.value = new Map()
    hydrationError.value = null
    inFlight.clear()
    hydrated = false
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
    markStartingDownload,
    remove,
    reset,
  }
})
