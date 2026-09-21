/**
 * How long a download attempt may go without a single byte before it is
 * declared dead.
 *
 * A stall deadline, deliberately not a cap on the whole transfer: a lecture is
 * tens of megabytes and a slow mobile link can legitimately spend half an hour
 * on one. What a live transfer never does is go two minutes without delivering
 * anything — the native side reports every chunk — so silence is the honest
 * signal. Comfortably above the hedge ceiling, which already bounds the silence
 * before the first byte.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 120_000

/** How often the stall watch looks at the clock. */
const STALL_CHECK_INTERVAL_MS = 5_000

/** What the stall watch resolves with; distinct from any real result. */
export const STALLED = Symbol("stalled")

export interface StallWatch {
  /** Resolves once the attempt has been silent for a whole deadline. */
  readonly expired: Promise<typeof STALLED>
  /** Report a byte: restarts the deadline. */
  readonly touch: () => void
  /** Stop watching; the promise then never settles. */
  readonly stop: () => void
}

/**
 * Watch an attempt for total silence and settle when it lasts too long.
 *
 * Nothing else bounds one: the adapter's promise settles only on a native
 * `completed` / `failed` event for its own id, and there are ways for neither
 * to arrive (an entry removed from the metadata store mid-flight, a
 * stalled-but-open connection iOS holds until its one-hour resource timeout).
 *
 * Only FOREGROUND time counts. A webview suspended in the user's pocket stops
 * delivering progress events and stops running timers, and reading that silence
 * as death would kill a transfer that is in fact still moving bytes. The clock
 * restarts on resume, so a genuinely dead transfer is still caught — one
 * deadline later, with the app in the user's hands.
 */
export function startStallWatch(): StallWatch {
  let lastByteAt = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  const expired = new Promise<typeof STALLED>((resolve) => {
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        lastByteAt = Date.now()
        return
      }
      if (Date.now() - lastByteAt < DOWNLOAD_STALL_TIMEOUT_MS) return
      resolve(STALLED)
    }, STALL_CHECK_INTERVAL_MS)
  })
  return {
    expired,
    touch: () => {
      lastByteAt = Date.now()
    },
    stop: () => clearInterval(timer),
  }
}
