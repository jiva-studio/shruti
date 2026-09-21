import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import type { Shruti } from "@shruti/shruti.js"
import type { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"
import { classifyTransferResult, decideBudget, type TransferOutcome } from "./downloadDecisions.js"
import type { DownloadDisk } from "./downloadDisk.js"
import type { DownloadFailureCause } from "./downloadFailureKey.js"
import type { DownloadNotices } from "./downloadNotices.js"
import type { DownloadRows } from "./downloadRows.js"
import type { TransferHandle } from "./inFlightTransfers.js"
import { startMediaTransfer } from "./mediaTransfer.js"
import { startStallWatch, STALLED } from "./stallWatch.js"

/** The quota store, read from the active registry per call rather than captured. */
type Quota = () => ReturnType<typeof useDownloadQuotaStore>

export interface DownloadAttemptDeps {
  readonly app: Shruti
  readonly rows: DownloadRows
  readonly quota: Quota
  readonly disk: DownloadDisk
  readonly notices: DownloadNotices
  readonly candidates: () => CdnServer[]
  readonly prefetchTranscript: (trackId: TrackId) => void
  /** Spend this track's one-off pass past the budget, if it holds one. */
  readonly spendBudgetException: (trackId: TrackId) => boolean
  readonly dropBudgetException: (trackId: TrackId) => void
  /** Start a fresh attempt holding a pass, from the notice's own button. */
  readonly downloadAnyway: (trackId: TrackId, path: string, filesize?: number | null) => void
}

export interface DownloadAttemptJob {
  readonly trackId: TrackId
  readonly path: string
  readonly filesize?: number | null
  /** A retry assumes the file on disk is bad and re-fetches over it. */
  readonly isRetryAfterFailure: boolean
  readonly transfer: TransferHandle
}

/** Airplane mode. A transfer started here waits for a network that never comes. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

type Gate =
  | { readonly kind: "settled"; readonly localPath: string | null }
  | { readonly kind: "admitted" }

const REFUSED: Gate = { kind: "settled", localPath: null }

/**
 * One download attempt, in phases: probe the cache (and repair what it
 * contradicts), guard on connectivity, ask the budget, move the bytes, record
 * the outcome. Every state write is gated on the attempt still being the live
 * one — a wipe bumps the epoch, and the stall watch abandons a dead transfer.
 */
export async function runDownloadAttempt(
  job: DownloadAttemptJob,
  deps: DownloadAttemptDeps
): Promise<string | null> {
  const { trackId, path, filesize, isRetryAfterFailure, transfer } = job
  const { app, rows, quota, disk, notices } = deps
  const epoch = rows.currentEpoch()
  let abandoned = false
  const live = (): boolean => epoch === rows.currentEpoch()
  const fresh = (): boolean => live() && !abandoned
  const cancelled = (): boolean => transfer.aborter.signal.aborted
  // Armed for the whole attempt; the probe is a platform call too.
  const stall = startStallWatch()
  const probeUrl = buildServerUrl(app.activeServer.value, path)

  function failAttempt(cause: DownloadFailureCause): null {
    if (fresh()) {
      rows.setState(trackId, "failed")
      notices.announceDownloadFailed(transfer.origin.current, cause)
    }
    return null
  }

  /**
   * The stall watch gave up. The attempt is abandoned rather than awaited, so
   * it is barred from painting and the native transfer is cancelled under it.
   */
  function abandonStalled(): null {
    // The transfer stopped moving; the wire is the honest suspect.
    failAttempt("connectivity")
    abandoned = true
    transfer.aborter.abort()
    const url = transfer.url()
    if (url) void app.mediaDownloader.cancel(url).catch(() => {})
    // The DB row goes with the state: one left at "downloading" makes the next
    // attempt refuse with "already-in-progress" until a relaunch repairs it.
    void app
      .repositories()
      .mediaItems.upsert(trackId, "failed", null)
      .catch(() => {})
    return null
  }

  async function serveCached(cached: string): Promise<string> {
    await disk.adoptCachedFile(trackId, cached, filesize)
    if (!fresh()) return cached
    rows.setState(trackId, "completed")
    // A lecture saved before transcript prefetch shipped self-heals here.
    deps.prefetchTranscript(trackId)
    return cached
  }

  /**
   * A row still claiming "ready" for a file the cache does not have keeps a
   * phantom badge on Home and its bytes charged to the budget.
   */
  async function repairMissingRow(): Promise<void> {
    await app
      .repositories()
      .mediaItems.upsert(trackId, "failed", null)
      .catch(() => {})
    quota().uncharge(trackId)
  }

  /**
   * Ask the disk first, on every path including a retry. Two questions hang off
   * the one probe: "is there a file?", which the budget needs, and "is that one
   * any good?", which only a retry has to ask.
   */
  async function reconcileCache(): Promise<Gate | { kind: "continue"; onDisk: boolean }> {
    const probe = app.mediaDownloader.resolveLocalUrl(probeUrl)
    const cached = await Promise.race([probe, stall.expired])
    if (cached === STALLED) return { kind: "settled", localPath: abandonStalled() }
    if (cancelled()) return REFUSED
    disk.recordProbe(trackId, cached !== null)
    if (isRetryAfterFailure) return { kind: "continue", onDisk: cached !== null }
    if (cached) return { kind: "settled", localPath: await serveCached(cached) }
    await repairMissingRow()
    return { kind: "continue", onDisk: false }
  }

  function deferForSpace(announce: boolean): null {
    if (!fresh()) return null
    rows.markDeferred(trackId)
    if (announce) notices.announceBudgetFull(() => deps.downloadAnyway(trackId, path, filesize))
    return null
  }

  /**
   * Everything above cost nothing; from here on we would be writing megabytes,
   * so the storage limit gets a say — before the "downloading" paint, so a
   * refused track never flashes a spinner it is not going to earn.
   */
  async function openTransferGate(): Promise<Gate> {
    transfer.setUrl(probeUrl)
    const cache = await reconcileCache()
    if (cache.kind !== "continue") return cache
    if (isOffline()) return { kind: "settled", localPath: failAttempt("connectivity") }
    await quota().ensureMeasured()
    // A remove that landed while the budget was measured must not be overtaken.
    if (cancelled()) return REFUSED
    const sizeBytes = quota().sizeOf(filesize)
    const decision = decideBudget({
      // Spent even when admitted anyway: a grant outlives no decision.
      exempt: deps.spendBudgetException(trackId),
      onDisk: cache.onDisk,
      hasRoom: quota().hasRoomFor(sizeBytes, trackId),
      origin: transfer.origin.current,
      measured: quota().isMeasured,
    })
    if (decision.kind === "defer") {
      return { kind: "settled", localPath: deferForSpace(decision.announce) }
    }
    quota().reserve(trackId, sizeBytes)
    return { kind: "admitted" }
  }

  async function evictStaleCache(): Promise<void> {
    await app.mediaDownloader.delete(probeUrl).catch(() => {})
    disk.recordProbe(trackId, false)
    await app
      .repositories()
      .mediaItems.upsert(trackId, "failed", null)
      .catch(() => {})
    // The row is no longer ready, so it holds no budget; the gate's
    // reservation stands and funds the bytes now on their way in.
    quota().uncharge(trackId)
  }

  function startTransfer(): ReturnType<typeof startMediaTransfer> {
    return startMediaTransfer({
      app,
      trackId,
      path,
      candidates: deps.candidates(),
      onByte: stall.touch,
      onProgress: (pct) => {
        if (fresh()) rows.setProgress(trackId, pct)
      },
    })
  }

  function settleOutcome(outcome: TransferOutcome): string | null {
    if (outcome.kind === "cancelled") {
      // The user's own decision. Falling back to idle rather than failed keeps
      // a red retry affordance off a row they asked us to drop.
      if (fresh()) rows.clearState(trackId)
      return null
    }
    if (outcome.kind === "failed") return failAttempt(outcome.cause)
    quota().settle(trackId, true)
    disk.recordProbe(trackId, true)
    if (!fresh()) return outcome.localPath
    rows.setState(trackId, "completed")
    // Promote the CDN that delivered, synchronously so the prefetch below sees
    // it; the activeServer watcher persists the preference.
    if (app.activeServer.value.id !== outcome.server.id) app.setActiveServer(outcome.server)
    deps.prefetchTranscript(trackId)
    return outcome.localPath
  }

  async function transferAndSettle(): Promise<string | null> {
    if (fresh()) {
      rows.setProgress(trackId, 0)
      rows.setState(trackId, "downloading")
    }
    if (isRetryAfterFailure) await evictStaleCache()
    const result = await Promise.race([startTransfer(), stall.expired])
    if (result === STALLED) return abandonStalled()
    return settleOutcome(classifyTransferResult(result))
  }

  try {
    const gate = await openTransferGate()
    if (gate.kind === "settled") return gate.localPath
    return await transferAndSettle()
  } catch (err) {
    console.error(`[downloads] failed for ${trackId}:`, err)
    return failAttempt("unknown")
  } finally {
    stall.stop()
    // Drop a grant never spent at the gate: a press buys the one call it made.
    deps.dropBudgetException(trackId)
    // Release a reservation still held; a no-op once success promoted it.
    quota().settle(trackId, false)
    // An abandoned attempt still holds its claim — hence the epoch gate, not
    // `fresh()`.
    if (live()) rows.clearPending(trackId)
    transfer.release()
  }
}
