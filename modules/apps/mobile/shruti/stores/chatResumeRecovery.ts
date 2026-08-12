/**
 * What one resume poll learned about a dropped turn.
 *
 *  - `running`     — the server is still generating it. The answer is coming.
 *  - `missing`     — the server answered, and has no buffer for this turn
 *                    (404: never received, expired, or not ours).
 *  - `unreachable` — the poll itself failed (offline, token refresh, 5xx).
 */
export type ResumeProbe = "running" | "missing" | "unreachable"

/** Keep polling, or give the turn up and leave the user a Retry. */
export type ResumeDecision = "poll" | "abandon"

/**
 * How long a dropped turn may stay on "thinking" once the server has STOPPED
 * claiming to be generating it.
 *
 * A stall (or any dropped socket) hands the turn to the resume poll, and while
 * the server reports `running` the poll follows it for the whole buffer TTL —
 * a ten-minute research turn is ordinary. The window here covers the other
 * answer: the server says it has nothing, or cannot be reached at all. A single
 * such reading is not evidence — a 404 immediately after the drop can be the
 * buffer write racing our first poll — so it is tolerated for a few polls
 * (`RESUME_POLL_MIN_MS` is 2.5 s, so this is ~6 of them). What it is not is
 * evidence to sit on for 24 h: before this window existed, an unrecoverable
 * turn kept its spinner until the buffer TTL, which is a day of dots for an
 * answer that was never coming.
 */
export const RESUME_RECOVERY_GRACE_MS = 15_000

export interface ResumeRecoveryInput {
  readonly probe: ResumeProbe
  /**
   * How long the poll has been getting non-`running` readings in a row, ms.
   * Zero on the first one; reset whenever the server says `running` again.
   */
  readonly unproductiveForMs: number
  /** Age of the pending record — measured against the server's buffer TTL. */
  readonly ageMs: number
  readonly ttlMs: number
  readonly graceMs?: number
}

/**
 * Whether the resume poll should keep following a dropped turn or give up on
 * it — the one place that decides when the user gets a Retry.
 *
 * The rule is deliberately keyed on what the SERVER said, not on how long the
 * stream has been quiet: a stall the resume poll is about to recover must not
 * offer a button that races the recovery. So `running` always keeps polling
 * (inside the TTL), and only a server that reports nothing — or no server at
 * all — starts the clock that ends in `abandon`.
 */
export function decideResumeRecovery(input: ResumeRecoveryInput): ResumeDecision {
  const { probe, unproductiveForMs, ageMs, ttlMs, graceMs = RESUME_RECOVERY_GRACE_MS } = input
  // Past the buffer TTL nothing can be recovered, whatever the server claims:
  // a turn stuck `running` for a day is not going to finish.
  if (ageMs > ttlMs) return "abandon"
  if (probe === "running") return "poll"
  return unproductiveForMs >= graceMs ? "abandon" : "poll"
}
