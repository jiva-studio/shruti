import type { TrackId } from "@lib/domain/core.js"
import type { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"
import type { DownloadDisk } from "./downloadDisk.js"
import type { DownloadRows } from "./downloadRows.js"

/** The quota store, read from the active registry per call rather than captured. */
type Quota = () => ReturnType<typeof useDownloadQuotaStore>

/**
 * How many prefetch jobs transfer at once. Above one, the native plugin's
 * WorkManager (Android) / URLSession (iOS) drops everything past the first
 * transfer to "failed", so restoring a playlist is serialised here. Callers
 * that await a download of their own (the player's auto-start) keep their fast
 * path — this queue is the parallel-spam entry point and the one we throttle.
 */
const PREFETCH_CONCURRENCY = 1

interface PrefetchJob {
  readonly trackId: TrackId
  readonly path: string
  readonly sizeBytes: number
}

export interface PrefetchQueue {
  /** Fire-and-forget enqueue for "add to playlist" and data-restore flows. */
  prefetch(trackId: TrackId, path: string, filesize?: number | null): void
  /** Drain again after something freed storage; a no-op when nothing waits. */
  resumeDeferred(): void
  /** Drop a track before its turn starts, rolling back its optimistic paint. */
  cancel(trackId: TrackId): void
  clear(): void
}

export interface PrefetchQueueDeps {
  readonly rows: DownloadRows
  readonly quota: Quota
  readonly disk: DownloadDisk
  readonly isInFlight: (trackId: TrackId) => boolean
  readonly ensureDownloaded: (job: PrefetchJob) => Promise<unknown>
}

/**
 * The FIFO behind auto-download: jobs are admitted in order and stop at the
 * first one the storage budget cannot fund, so a 100-track playlist downloads
 * as far as the budget allows and continues on its own as the user clears
 * lectures. Deferred jobs stay in the queue, in order.
 */
export function createPrefetchQueue(deps: PrefetchQueueDeps): PrefetchQueue {
  const { rows, quota, disk } = deps
  const jobs: PrefetchJob[] = []
  const queuedTrackIds = new Set<TrackId>()
  /** How many jobs are transferring; a slot is handed back when its job settles. */
  let activeJobs = 0
  /** Guards the tail walk, which is async and must not overlap itself. */
  let settlingTail = false

  /** Still the tail walk's to settle: waiting in the FIFO, not transferring. */
  function awaitingFunding(trackId: TrackId): boolean {
    return queuedTrackIds.has(trackId) && !deps.isInFlight(trackId)
  }

  function dropFromQueue(trackId: TrackId): void {
    const idx = jobs.findIndex((job) => job.trackId === trackId)
    if (idx >= 0) jobs.splice(idx, 1)
    queuedTrackIds.delete(trackId)
  }

  /**
   * Admit jobs from the head up to the concurrency, stopping at the first the
   * budget cannot fund. Nothing is held across an await: a slot belongs to one
   * job and is handed back when that job settles, so a transfer that never
   * settles cannot shut the queue down for the rest of the process.
   */
  function pumpQueue(): void {
    while (activeJobs < PREFETCH_CONCURRENCY && jobs.length > 0) {
      const head = jobs[0]!
      if (!quota().hasRoomFor(head.sizeBytes)) {
        if (!settlingTail) void settleUnfundedTail()
        return
      }
      // Reserved up front so a multi-job batch is measured against the budget
      // as a whole, not job-by-job against a stale total.
      quota().reserve(head.trackId, head.sizeBytes)
      jobs.shift()
      queuedTrackIds.delete(head.trackId)
      activeJobs += 1
      void runJob(head)
    }
  }

  async function runJob(job: PrefetchJob): Promise<void> {
    rows.markStartingDownload(job.trackId)
    try {
      await deps.ensureDownloaded(job)
    } catch {
      // The attempt records "failed" itself; the queue must keep moving.
    } finally {
      activeJobs -= 1
      pumpQueue()
    }
  }

  /**
   * The budget is spent. Before painting the waiting tail as held back for
   * space, ask the disk about each of them once: a lecture whose audio is
   * already saved is downloaded no matter what `media_items` says. The rest are
   * painted and nothing is said — nobody is waiting on a particular one, and
   * the rows now carry the state themselves.
   *
   * The walk is over a snapshot with an await per entry, and the pump can admit
   * one of those entries meanwhile; such an entry is a live transfer, not tail,
   * hence the ownership check on both sides of the probe.
   */
  async function settleUnfundedTail(): Promise<void> {
    settlingTail = true
    try {
      let adopted = false
      for (const job of [...jobs]) {
        if (!awaitingFunding(job.trackId)) continue
        const onDisk = await disk.adoptIfOnDisk(job.trackId, job.path, job.sizeBytes)
        if (!awaitingFunding(job.trackId)) continue
        if (onDisk) {
          dropFromQueue(job.trackId)
          adopted = true
          continue
        }
        rows.markDeferred(job.trackId)
      }
      // Adopting shortens the queue and charges the budget, so the gate is
      // re-run with the adopted bytes counted in.
      if (adopted) pumpQueue()
    } finally {
      settlingTail = false
    }
  }

  async function drain(): Promise<void> {
    // Never budget against an unmeasured zero — on a cold start that would let
    // the whole queue through before the first measurement lands. Concurrent
    // callers share the one measurement, so this needs no guard of its own.
    await quota().ensureMeasured()
    pumpQueue()
  }

  /**
   * A track already queued or in flight is a no-op, so a double tap costs
   * nothing. The row paints as `downloading` right away — unless it is `failed`,
   * which must survive so the attempt takes the retry path — or as `deferred`
   * when the budget has no room: no spinner for a transfer that will not start.
   */
  function prefetch(trackId: TrackId, path: string, filesize?: number | null): void {
    if (queuedTrackIds.has(trackId)) return
    if (deps.isInFlight(trackId)) return
    const current = rows.effectiveState(trackId)
    if (current === "completed") return
    const sizeBytes = quota().sizeOf(filesize)
    queuedTrackIds.add(trackId)
    jobs.push({ trackId, path, sizeBytes })
    if (current !== "failed") {
      if (quota().hasRoomFor(sizeBytes)) rows.markStartingDownload(trackId)
      else rows.markDeferred(trackId)
    }
    void drain()
  }

  function cancel(trackId: TrackId): void {
    if (!queuedTrackIds.has(trackId)) return
    dropFromQueue(trackId)
    // Roll back the paint applied at enqueue time, but only while the track has
    // not started transferring.
    const painted = rows.states.value.get(trackId)
    if (deps.isInFlight(trackId)) return
    if (painted === "downloading" || painted === "deferred") rows.clearState(trackId)
  }

  return {
    prefetch,
    resumeDeferred: () => {
      if (jobs.length === 0) return
      void drain()
    },
    cancel,
    clear: () => {
      jobs.length = 0
      queuedTrackIds.clear()
    },
  }
}
