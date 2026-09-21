import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"

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

/**
 * Arm a timer, returning the call that disarms it. Time has a lifetime a test
 * must control, so the schedule is a parameter with a platform-shaped default
 * rather than something this layer reaches for.
 */
export type ScheduleFn = (run: () => void, delayMs: number) => () => void

const platformSchedule: ScheduleFn = (run, delayMs) => {
  const id = setTimeout(run, delayMs)
  return () => clearTimeout(id)
}

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
export function hedgeCandidates(
  candidates: readonly CdnServer[],
  path: string,
  transfer: MediaTransferFn,
  onProgress?: (pct: number) => void,
  schedule: ScheduleFn = platformSchedule
): Promise<HedgeOutcome> {
  return new Promise<HedgeOutcome>((resolve) => {
    // url → the controller that aborts just that attempt.
    const running = new Map<string, AbortController>()
    const hedgeTimers: (() => void)[] = []
    let disarmCeiling: (() => void) | null = null
    let next = 0
    let winner: string | null = null
    let settled = false

    function clearHedgeTimers(): void {
      for (const disarm of hedgeTimers) disarm()
      hedgeTimers.length = 0
    }

    function clearCeiling(): void {
      if (disarmCeiling === null) return
      disarmCeiling()
      disarmCeiling = null
    }

    /** Bound the silence. Re-armed if a winner dies and the race restarts. */
    function armCeiling(): void {
      clearCeiling()
      disarmCeiling = schedule(() => {
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
        hedgeTimers.push(schedule(startNext, HEDGE_INTERVAL_MS))
      }
    }

    armCeiling()
    startNext()
  })
}
