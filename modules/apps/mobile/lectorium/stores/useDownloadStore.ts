import { defineStore } from "pinia"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"
import { useWantedTranscriptLanguages } from "@lectorium/composables/useWantedTranscriptLanguages.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useDownloadQuotaStore } from "./useDownloadQuotaStore.js"
import { createDownloadDisk } from "./downloads/downloadDisk.js"
import { createDownloadEviction } from "./downloads/downloadEviction.js"
import { createDownloadNotices } from "./downloads/downloadNotices.js"
import { createDownloadRows, type DownloadState } from "./downloads/downloadRows.js"
import { createDownloadRunner } from "./downloads/downloadRunner.js"
import { createPrefetchQueue } from "./downloads/prefetchQueue.js"
import { useServerFallback } from "./downloads/useServerFallback.js"
import { useTranscriptPrefetch } from "./downloads/useTranscriptPrefetch.js"

export type { DownloadState }
export type { DownloadOrigin } from "./downloads/downloadNotices.js"
export { DOWNLOAD_STALL_TIMEOUT_MS } from "./downloads/stallWatch.js"

/** How long a failed hydrate is left alone before the next screen may retry. */
const HYDRATE_RETRY_COOLDOWN_MS = 30_000

/**
 * Per-track media download state. The source of truth is the user DB
 * (`IMediaItemRepository`) — this store hydrates once from `listReady()` so the
 * "downloaded" indicator survives app relaunches, and in-flight signals are
 * tracked in memory for the duration of a session.
 *
 * The parts live under `stores/downloads/`: the reactive rows and their pending
 * claims, the user-facing notices, the disk probes, one download attempt, the
 * prefetch FIFO and eviction. This composes them and owns the first hydrate.
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useLectorium()
  const { t } = useI18n()
  const toast = useToast()
  const fallback = useServerFallback()
  const transcriptPrefetch = useTranscriptPrefetch()

  const rows = createDownloadRows()
  const notices = createDownloadNotices({ t: (key) => t(key), toast })
  const disk = createDownloadDisk({
    app,
    rows,
    quota: useDownloadQuotaStore,
    isInFlight: (trackId) => runner.isInFlight(trackId),
  })
  const runner = createDownloadRunner({
    app,
    rows,
    quota: useDownloadQuotaStore,
    disk,
    notices,
    candidates: fallback.candidates,
    prefetchTranscript: (trackId) => void transcriptPrefetch.prefetchForTrack(trackId),
  })
  const queue = createPrefetchQueue({
    rows,
    quota: useDownloadQuotaStore,
    disk,
    isInFlight: runner.isInFlight,
    ensureDownloaded: (job) =>
      runner.ensureDownloaded(job.trackId, job.path, job.sizeBytes, "queue"),
  })
  const eviction = createDownloadEviction({
    app,
    rows,
    quota: useDownloadQuotaStore,
    disk,
    cancelInFlight: runner.cancelInFlight,
    resumeDeferred: queue.resumeDeferred,
  })

  // Transcripts are prefetched only in the languages the user reads, so picking
  // up a NEW one would leave every already-saved lecture without it. Watched
  // here — the store is the app's single instance — and only on a WIDENING:
  // dropping a language needs no fetch. `ready` gates the first comparison: the
  // set starts as a guess from the UI locale, and becoming the user's own is
  // not a choice anyone made.
  const wanted = useWantedTranscriptLanguages()
  let wantedBaseline: readonly string[] | null = null
  watch(
    () => (wanted.ready.value ? wanted.languages.value : null),
    (next) => {
      if (!next) return
      const previous = wantedBaseline
      wantedBaseline = next
      if (!previous) return
      if (next.every((language) => previous.includes(language))) return
      void transcriptPrefetch.backfillDownloaded()
    },
    { immediate: true }
  )

  // Set when the most recent `hydrate()` could not read the user DB (schema
  // drift, db locked, plugin error). Without it the UI shows every track as
  // "not downloaded" with no signal why.
  const hydrationError = ref<string | null>(null)
  let hydrated = false
  // Coalesced (Home, Search and Settings all hydrate defensively on mount) and
  // backed off after a failure, so a hard-failing DB does not get a write plus
  // a read on every screen access.
  let hydratePromise: Promise<void> | null = null
  let lastHydrateFailAt = 0

  /** Rebuild the reactive rows from the user DB. Idempotent. */
  async function hydrate(): Promise<void> {
    if (hydrated) return
    if (hydratePromise) return hydratePromise
    if (lastHydrateFailAt && Date.now() - lastHydrateFailAt < HYDRATE_RETRY_COOLDOWN_MS) return
    hydratePromise = (async () => {
      try {
        const repo = app.repositories().mediaItems
        // Recover rows the previous session left at "downloading" because the
        // app was force-closed mid-transfer: one keeps the Download button
        // locked out with "already-in-progress" until the user wipes data.
        const stale = await repo.failStaleDownloads()
        const ready = await repo.listReady()
        const next = new Map<TrackId, DownloadState>()
        for (const item of ready) next.set(item.trackId, "completed")
        rows.states.value = next
        // Size what is on disk before anything can be queued, so the session's
        // first budget decision is not made against a zero.
        await useDownloadQuotaStore().refresh()
        hydrated = true
        hydrationError.value = null
        lastHydrateFailAt = 0
        // Only now, with the ledger measured, can a reclaim credit the right
        // number back. Deliberately not awaited: housekeeping is not something
        // a screen should wait on.
        void eviction.collectOrphans()
        // Same reasoning: the demotion above is a guess the disk can overturn,
        // and asking it is a series of native round trips a cold start must
        // not sit behind.
        void disk.reconcileStaleDownloads(stale.map((item) => item.trackId))
      } catch (err) {
        console.error("[downloads] hydrate failed:", err)
        hydrationError.value = err instanceof Error ? err.message : String(err)
        lastHydrateFailAt = Date.now()
        // Surface it wherever the user is; the back-off keeps it from
        // repeating on every screen that hydrates.
        void toast.error(t("errors.downloadsCacheUnavailable"))
      } finally {
        hydratePromise = null
      }
    })()
    return hydratePromise
  }

  /**
   * Roll back an optimistic "downloading" paint that will never resolve —
   * a track that turns out to have no audio variant to fetch, so nothing will
   * ever start an attempt. A real transfer or a terminal state is left alone.
   */
  function clearStartingDownload(trackId: TrackId): void {
    if (runner.isInFlight(trackId)) return
    if (rows.states.value.get(trackId) !== "downloading") return
    rows.clearState(trackId)
  }

  /**
   * Drop a track the user no longer wants offline. Mid-transfer this aborts the
   * native transfer, and the attempt then settles as cancelled — no red X on a
   * track the user chose to archive.
   */
  function cancelPrefetch(trackId: TrackId): void {
    if (runner.isInFlight(trackId)) {
      runner.cancelInFlight(trackId)
      return
    }
    queue.cancel(trackId)
  }

  /**
   * Wipe in-memory state and force a re-hydrate on next access, for the "Clear
   * user data" flow. The epoch is bumped first: an attempt started before the
   * wipe still resolves, but its writes become no-ops rather than painting rows
   * back into the freshly-emptied maps.
   */
  function reset(): void {
    rows.bumpEpoch()
    runner.reset()
    rows.clear()
    hydrationError.value = null
    queue.clear()
    disk.clear()
    useDownloadQuotaStore().reset()
    hydrated = false
    lastHydrateFailAt = 0
  }

  // Raising the limit must let the waiting tail through without the user
  // re-adding anything; lowering it just means the next job does not fit. A
  // budget that only just became measurable is the same event: what was
  // enqueued before it was refused for want of a number, not for want of room.
  watch([() => useDownloadQuotaStore().limitBytes, () => useDownloadQuotaStore().isMeasured], () =>
    queue.resumeDeferred()
  )

  return {
    states: rows.states,
    progress: rows.progress,
    hydrationError,
    getState: rows.getState,
    getEffectiveState: rows.getEffectiveState,
    getProgress: rows.getProgress,
    hydrate,
    ensureDownloaded: runner.ensureDownloaded,
    adoptCachedFile: disk.adoptCachedFile,
    prefetch: queue.prefetch,
    resumeDeferred: queue.resumeDeferred,
    cancelPrefetch,
    markPending: rows.markPending,
    clearPending: rows.clearPending,
    markStartingDownload: rows.markStartingDownload,
    clearStartingDownload,
    remove: eviction.remove,
    evict: eviction.evict,
    markEvictPending: eviction.markEvictPending,
    collectOrphans: eviction.collectOrphans,
    reset,
  }
})
