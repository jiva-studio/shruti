import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { MediaAudioKind, MediaItem } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import { err, ok, type Result } from "@kit/core"

export interface DownloadMediaInput {
  readonly trackId: TrackId
  /**
   * Storage key (full bucket path, including the `public/` prefix).
   * The use case re-resolves a fresh URL per attempt via
   * `buildServerUrl(server, path)`, so a CDN swap mid-flight cannot
   * produce a stale URL.
   */
  readonly path: string
  /**
   * Ordered candidate servers to try. The caller (download store)
   * is expected to put the currently-active server first so we hit
   * the happy path on the first attempt and only iterate the rest
   * on failure.
   */
  readonly candidates: readonly CdnServer[]
  /** Which audio version is being fetched. Defaults to "original". */
  readonly kind?: MediaAudioKind
}

/**
 * Raw byte-transfer callback. The use case is layer-pure — it can't
 * import `@ports/app/IMediaDownloader` — so the caller (typically the
 * download store) passes the adapter-backed transfer as a plain
 * function. Returning the local URL fulfils the use case's contract
 * to persist `localPath` on success.
 *
 * The optional `onProgress` is forwarded down to the platform downloader
 * so the UI can render a real radial gauge. `total` may be ≤ 0 when the
 * server omits Content-Length — callers must guard against that.
 *
 * `signal` aborts this attempt alone; the transfer must then reject with a
 * cancellation carrying `reason: "superseded"`. That is how the hedge drops
 * its losers without them looking like failures or like the user's own
 * cancel.
 */
export type MediaTransferFn = (
  url: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
) => Promise<string>

export interface DownloadMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly transfer: MediaTransferFn
  /**
   * Used only to make the "claim the download slot" check-and-set atomic.
   * The long transfer itself runs outside any transaction.
   */
  readonly unitOfWork: IUnitOfWork
}

export type DownloadMediaError =
  | "already-in-progress"
  | "no-candidates"
  | "cancelled"
  | "transfer-failed"
  | "persist-failed"

export interface DownloadMediaSuccess {
  readonly mediaItem: MediaItem
  /** The CDN server whose URL actually delivered the bytes. */
  readonly server: CdnServer
}

/**
 * Why a transfer stopped on a local decision. Mirrors the port's
 * `DownloadCancelReason`; the use case is layer-pure and cannot import it.
 */
export type TransferCancelReason = "user" | "superseded"

/**
 * The reason an attempt was aborted on purpose (`DownloadCancelledError`
 * thrown by the adapter), or `null` when it failed on its own.
 *
 * Matched by name because the use case cannot import the port that defines
 * the class. An unlabelled cancellation counts as `"user"`: an abort we did
 * not ask for came from outside, and the safe reading of "outside" is the
 * person — stopping is recoverable, silently racing on is not.
 */
function cancelReason(e: unknown): TransferCancelReason | null {
  if (!(e instanceof Error) || e.name !== "DownloadCancelledError") return null
  const reason = (e as { reason?: unknown }).reason
  return reason === "superseded" ? "superseded" : "user"
}

/**
 * How long a candidate may stay silent before the NEXT one is started
 * alongside it. The slow one is not cancelled — it may still be the one
 * that delivers.
 */
export const HEDGE_INTERVAL_MS = 5_000

/**
 * How long the whole connection phase may stay silent before the download
 * is declared failed. Bounds the user's wait at roughly one timeout instead
 * of the sum of one per region.
 */
export const HEDGE_CEILING_MS = 15_000

/** What the hedge settled on. */
type HedgeOutcome =
  | { readonly kind: "delivered"; readonly server: CdnServer; readonly localUrl: string }
  | { readonly kind: "failed" }
  | { readonly kind: "cancelled" }

/**
 * Race the CDN candidates through their connection phase, then let exactly
 * one of them transfer the body.
 *
 * Trying regions strictly one after another costs a full timeout per dead
 * region, so three dead regions kept the user waiting for the sum of three.
 * Here candidate 1 starts alone; if it has not produced a byte after
 * `HEDGE_INTERVAL_MS` candidate 2 joins it (candidate 1 is NOT cancelled —
 * slow to answer is not dead), and so on down the list. The first candidate
 * to deliver a byte wins and every other in-flight one is cancelled right
 * there, before it has written anything: that, not per-candidate temp files,
 * is what keeps a single writer on the shared destination. If nothing has
 * arrived by `HEDGE_CEILING_MS` the whole thing fails — one timeout, not N.
 *
 * A candidate that fails outright doesn't wait for its timer; it pulls the
 * next candidate in immediately.
 */
function hedgeCandidates(
  candidates: readonly CdnServer[],
  path: string,
  transfer: MediaTransferFn,
  onProgress?: (pct: number) => void
): Promise<HedgeOutcome> {
  return new Promise<HedgeOutcome>((resolve) => {
    // url → the controller that aborts just that attempt.
    const running = new Map<string, AbortController>()
    const hedgeTimers: ReturnType<typeof setTimeout>[] = []
    let ceilingTimer: ReturnType<typeof setTimeout> | null = null
    let next = 0
    let winner: string | null = null
    let settled = false

    function clearHedgeTimers(): void {
      for (const t of hedgeTimers) clearTimeout(t)
      hedgeTimers.length = 0
    }

    function clearCeiling(): void {
      if (ceilingTimer === null) return
      clearTimeout(ceilingTimer)
      ceilingTimer = null
    }

    /** Bound the silence. Re-armed if a winner dies and the race restarts. */
    function armCeiling(): void {
      clearCeiling()
      ceilingTimer = setTimeout(() => {
        if (winner !== null) return
        // Nobody answered inside the ceiling. Drop the stragglers as losers,
        // not as a user cancel: this is a failure and must read as one.
        dropOthers(null)
        finish({ kind: "failed" })
      }, HEDGE_CEILING_MS)
    }

    function finish(outcome: HedgeOutcome): void {
      if (settled) return
      settled = true
      clearHedgeTimers()
      clearCeiling()
      resolve(outcome)
    }

    /** Drop every attempt but `keep`. Losers must never surface anywhere. */
    function dropOthers(keep: string | null): void {
      for (const [url, controller] of running) {
        if (url !== keep) controller.abort()
      }
    }

    function claimWinner(url: string): void {
      if (winner !== null || settled) return
      winner = url
      // Bytes are moving: nothing more may join the race, and the silence
      // ceiling no longer applies.
      clearHedgeTimers()
      clearCeiling()
      dropOthers(url)
    }

    function startNext(): void {
      if (settled || winner !== null) return
      if (next >= candidates.length) return
      const server = candidates[next++]!
      const url = buildServerUrl(server, path)
      const controller = new AbortController()
      running.set(url, controller)

      void transfer(
        url,
        (received, total) => {
          if (received > 0) claimWinner(url)
          if (url !== winner) return
          if (total > 0) onProgress?.(Math.round((received / total) * 100))
        },
        controller.signal
      )
        .then((localUrl) => {
          // A transfer can complete without ever reporting progress (a tiny
          // file, a platform that skips the first event), so the winner is
          // claimed here too rather than assumed.
          claimWinner(url)
          running.delete(url)
          finish({ kind: "delivered", server, localUrl })
        })
        .catch((e: unknown) => {
          running.delete(url)
          const reason = cancelReason(e)
          // A loser we cancelled ourselves. Not a fault, not a decision the
          // user made: say nothing, and do NOT pull in another candidate —
          // whoever beat it is already transferring.
          if (reason === "superseded") return
          // The user stopped the download. Terminal for the whole walk.
          if (reason === "user") {
            dropOthers(null)
            return finish({ kind: "cancelled" })
          }
          if (winner !== null && url !== winner) {
            // A straggler dying while the winner transfers is noise: it must
            // not reset the gauge, pull in another region, or end anything.
            return
          }
          const exhausted = next >= candidates.length && running.size === 0
          if (winner !== null) {
            // The candidate that was actually moving bytes died mid-body —
            // the in-flight CDN failure this fallback exists for. Its rivals
            // were cancelled the moment it won, so re-open the race on
            // whatever is left instead of reporting a failure we can still
            // avoid. A fresh connection phase gets a fresh ceiling.
            winner = null
            if (exhausted) return finish({ kind: "failed" })
            armCeiling()
          } else if (exhausted) {
            return finish({ kind: "failed" })
          }
          // Tell the UI to draw 0%: whoever transfers next starts from byte
          // zero, and the gauge must not keep showing this attempt's chunk.
          onProgress?.(0)
          // Don't sit on a dead candidate's timer — bring the next one in now.
          startNext()
        })

      if (next < candidates.length) {
        hedgeTimers.push(setTimeout(startNext, HEDGE_INTERVAL_MS))
      }
    }

    armCeiling()
    startNext()
  })
}

/**
 * Download a track's media and persist the lifecycle in the user DB
 * so the UI can recover the "ready" indicator after a relaunch. The
 * state machine is pending → downloading → ready / failed, serialised
 * through `IMediaItemRepository.upsert`.
 *
 * `input.candidates` are hedged rather than walked one at a time (see
 * `hedgeCandidates`): they enter the race `HEDGE_INTERVAL_MS` apart, the
 * first to deliver a byte wins, and the rest are cancelled on the spot.
 * That makes it the runtime CDN fallback — if the user's active CDN
 * degrades after the Welcome probe the download still completes — while
 * capping the wait at one timeout instead of one per region. The caller
 * inspects `success.server` to decide whether to promote a different CDN
 * to active. A cancel the USER asked for ends everything with
 * `err("cancelled")`; a loser being dropped is invisible.
 *
 * Optional `onProgress(pct)` reports the rounded percentage 0..100 only
 * when the byte total is known.
 */
export async function downloadMedia(
  input: DownloadMediaInput,
  deps: DownloadMediaDeps,
  onProgress?: (pct: number) => void
): Promise<Result<DownloadMediaSuccess, DownloadMediaError>> {
  if (input.candidates.length === 0) return err("no-candidates")
  const kind = input.kind ?? "original"

  // Check-and-claim the "downloading" slot atomically. Two simultaneous
  // taps on the same track race here; the unit-of-work serialises them,
  // so the loser sees state="downloading" and bows out with
  // "already-in-progress" instead of starting a parallel transfer.
  type Claim =
    | { kind: "busy" }
    | { kind: "cached"; mediaItem: MediaItem }
    | { kind: "claimed"; id: MediaItemId }
  const claim = await deps.unitOfWork.run<Claim>(async (tx) => {
    const existing = await deps.mediaItems.getByTrack(input.trackId, kind)
    if (existing?.state === "downloading") return { kind: "busy" }
    if (existing?.state === "ready" && existing.localPath) {
      return { kind: "cached", mediaItem: existing }
    }
    // Keep the row id: it identifies OUR claim, so a later release can tell
    // it from a row a newer task claimed after a wipe.
    //
    // `tx` is handed down because `upsert` now runs itself through a unit of
    // work: without the handle it would ask for a transaction of its own and
    // wait behind the one we are inside, which never ends (#1790).
    const claimed = await deps.mediaItems.upsert(input.trackId, "downloading", null, kind, tx)
    return { kind: "claimed", id: claimed.id }
  })

  if (claim.kind === "busy") return err("already-in-progress")
  if (claim.kind === "cached") {
    // No transfer happened, so we can't truthfully attribute a server.
    // Pick the first candidate (active server) — callers checking
    // `success.server` against `activeServer` will treat this as a
    // no-op promotion, which is correct: nothing changed.
    return ok({ mediaItem: claim.mediaItem, server: input.candidates[0]! })
  }

  // No within-server retry: the prober already weeded out servers that 404
  // the config, and an in-flight CDN failure is what the hedge is for. URLs
  // are built inside the hedge, per attempt — the active-server ref can
  // mutate while we wait, and a URL captured up front would silently target
  // a stale template.
  const outcome = await hedgeCandidates(input.candidates, input.path, deps.transfer, onProgress)

  if (outcome.kind === "cancelled") {
    // A cancellation the user asked for is a decision, not a CDN fault.
    // Drop the row we claimed rather than demoting it to "failed": the
    // cancel usually comes from a remove that deletes the track's rows
    // anyway, and an upsert racing behind that delete would resurrect it as
    // litter. Deleting releases the "downloading" claim so a later tap can
    // start over — but only OUR claim: if the row was deleted and re-claimed
    // meanwhile (a wipe, then a newer task), its id differs and deleting it
    // would strip that task's guard.
    try {
      const current = await deps.mediaItems.getByTrack(input.trackId, kind)
      if (current?.id === claim.id) await deps.mediaItems.deleteById(claim.id)
    } catch {
      /* swallow — best-effort release of the claimed row */
    }
    return err("cancelled")
  }

  if (outcome.kind === "failed") {
    // Every CDN failed. `err("transfer-failed")` is the single failure
    // mode the UI can render; the use case stays IO-free, so logging the
    // underlying error is the composition root's job (error-handling
    // policy: the view controller catches and logs at the outer edge).
    // Best-effort mark "failed"; if the upsert itself rejects we don't
    // want a second exception masking the original transfer failure.
    try {
      await deps.mediaItems.upsert(input.trackId, "failed", null, kind)
    } catch {
      /* swallow — surfacing the transfer error matters more */
    }
    return err("transfer-failed")
  }

  // Bytes are on disk. The DB write is a separate failure mode (locked,
  // disk full, schema drift) and must not be conflated with a transfer
  // failure — Retry has different semantics for the two: a persist
  // retry should not re-download megabytes that are already cached.
  try {
    const saved = await deps.mediaItems.upsert(input.trackId, "ready", outcome.localUrl, kind)
    return ok({ mediaItem: saved, server: outcome.server })
  } catch {
    return err("persist-failed")
  }
}
