import { defineStore } from "pinia"
import { ref } from "vue"
import { downloadMedia } from "@usecases/downloads/downloadMedia.js"
import { removeDownloadedMedia } from "@usecases/downloads/removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "@usecases/downloads/removeDownloadedTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
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
  // Bounded FIFO for prefetch-style enqueues. Without this, restoring
  // many tracks at once fires `ensureDownloaded` in a tight loop and
  // the native plugin's WorkManager (Android) / URLSession (iOS) drops
  // everything past the first transfer to "failed". The queue keeps
  // explicit-await callers (player auto-start) on their own fast path
  // — `prefetch` is the parallel-spam entry point and is the one we
  // serialize.
  const PREFETCH_CONCURRENCY = 1
  const prefetchQueue: Array<{ trackId: TrackId; path: string }> = []
  const queuedTrackIds = new Set<TrackId>()
  let queueDraining = false
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
          // server when the download started. The activeServer watcher
          // in initShruti persists the new preference so the next
          // session also starts from this CDN; the transcript prefetch
          // (kicked off below) sees the updated active server because
          // we set it synchronously here.
          if (fresh() && app.activeServer.value.id !== result.value.server.id) {
            app.setActiveServer(result.value.server)
          }
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

  async function drainPrefetchQueue(): Promise<void> {
    if (queueDraining) return
    queueDraining = true
    try {
      while (prefetchQueue.length > 0) {
        const batch = prefetchQueue.splice(0, PREFETCH_CONCURRENCY)
        await Promise.allSettled(
          batch.map(async (job) => {
            queuedTrackIds.delete(job.trackId)
            try {
              await ensureDownloaded(job.trackId, job.path)
            } catch {
              // ensureDownloaded already records "failed"; don't break the queue.
            }
          })
        )
      }
    } finally {
      queueDraining = false
    }
  }

  /**
   * Fire-and-forget enqueue for "add to playlist" / data-restore flows.
   * Replaces a previous unbounded parallel dispatch that caused every
   * download past the first to fail when the native plugin's transfer
   * limit was exceeded (issue #474). Skips tracks already in flight or
   * already queued — same-track double-tap is a no-op.
   *
   * Marks the row as `downloading` immediately on enqueue (unless it
   * was already `failed` — leave that state intact so `ensureDownloaded`
   * still picks the retry path) so the dim treatment doesn't flicker
   * between `idle` and `downloading` while the FIFO is draining.
   */
  function prefetch(trackId: TrackId, path: string): void {
    if (queuedTrackIds.has(trackId)) return
    if (inFlight.has(trackId)) return
    const current = states.value.get(trackId)
    if (current === "completed") return
    queuedTrackIds.add(trackId)
    prefetchQueue.push({ trackId, path })
    if (current !== "failed") markStartingDownload(trackId)
    void drainPrefetchQueue()
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
    const current = states.value.get(trackId)
    // Preserve a terminal state. "completed" must not visually rewind to
    // "downloading" on re-add; "failed" must survive so a follow-up
    // `ensureDownloaded` takes the retry path (which runs the iOS
    // phantom-cache cleanup gated on `state === "failed"`). Overwriting
    // "failed" here would suppress that cleanup for re-add-after-failure.
    if (current === "completed" || current === "failed") return
    setProgress(trackId, 0)
    setState(trackId, "downloading")
  }

  /**
   * Roll back an optimistic "downloading" paint that will never resolve.
   * Used when `add()` claimed "downloading" up front but the track turns
   * out to have no audio variant to fetch — nothing will ever call
   * `ensureDownloaded`, so the spinner would otherwise stick forever.
   * Only clears a state we ourselves set optimistically; a real in-flight
   * download (or any terminal state) is left untouched.
   */
  function clearStartingDownload(trackId: TrackId): void {
    if (inFlight.has(trackId)) return
    if (states.value.get(trackId) !== "downloading") return
    const nextStates = new Map(states.value)
    nextStates.delete(trackId)
    states.value = nextStates
    const nextProgress = new Map(progress.value)
    if (nextProgress.delete(trackId)) progress.value = nextProgress
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
   * Drop a track from the prefetch FIFO before its turn starts. Called
   * by `playlist.archive` so archiving a track that the auto-download
   * loop (or "add to playlist") has just queued does not waste bandwidth
   * cabling a file the user no longer wants offline. If the track is
   * already mid-flight there is no AbortSignal yet — the download
   * resolves naturally and lands in the (now archived) cache; that's
   * acceptable for the rare race.
   */
  function cancelPrefetch(trackId: TrackId): void {
    if (!queuedTrackIds.has(trackId)) return
    const idx = prefetchQueue.findIndex((j) => j.trackId === trackId)
    if (idx >= 0) prefetchQueue.splice(idx, 1)
    queuedTrackIds.delete(trackId)
    // Roll back the optimistic "downloading" paint applied at enqueue
    // time, but only if the track hasn't started transferring yet.
    if (!inFlight.has(trackId) && states.value.get(trackId) === "downloading") {
      const nextStates = new Map(states.value)
      nextStates.delete(trackId)
      states.value = nextStates
      const nextProgress = new Map(progress.value)
      if (nextProgress.delete(trackId)) progress.value = nextProgress
    }
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
    prefetchQueue.length = 0
    queuedTrackIds.clear()
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
    cancelPrefetch,
    markStartingDownload,
    clearStartingDownload,
    remove,
    reset,
  }
})
