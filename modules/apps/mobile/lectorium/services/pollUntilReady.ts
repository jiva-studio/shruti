export interface PollOptions {
  /** Hard cap in ms before throwing. Default 480_000 (8 min) — worst-case AWS cold render observed at ~6 min in production logs; YC sync render is much shorter (~120 s). */
  readonly timeoutMs?: number
  /** Gap between probes in ms. Default 2_000. */
  readonly intervalMs?: number
  /** Per-probe HEAD timeout in ms. Default 4_000. */
  readonly probeTimeoutMs?: number
  /**
   * External cancellation — typically wired to the loading-modal dismiss
   * action. When the signal aborts, the loop rejects with the signal's
   * `reason` instead of waiting for the next interval.
   */
  readonly signal?: AbortSignal
}

/**
 * HEAD-poll a URL until it returns 200, or throw on timeout / abort.
 * Used by share-{audio,video} handlers to wait out async-render flows
 * before downloading. No-op when the file is already on the CDN — the
 * first probe returns 200 and the function resolves immediately.
 *
 * The exact failure mode depends on backend:
 *  - AWS share-video returns `202 ready:false` and starts a worker; the
 *    file lands ~100s later. Polling waits.
 *  - YC share-video returns `200 ready:true` only after the inline render
 *    completes (~120s); the predicted file is already there by then, so
 *    the first probe is an instant 200.
 *
 * Either way, the same call works.
 */
export async function pollUntilReady(url: string, opts: PollOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 480_000
  const intervalMs = opts.intervalMs ?? 2_000
  const probeTimeoutMs = opts.probeTimeoutMs ?? 4_000
  const signal = opts.signal

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw signal.reason ?? new Error("pollUntilReady aborted")
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(probeTimeoutMs) })
      if (r.ok) return
    } catch {
      // network error / per-probe timeout — keep polling, not fatal
    }
    await sleep(intervalMs, signal)
  }
  throw new Error(`pollUntilReady timed out after ${timeoutMs}ms: ${url}`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
