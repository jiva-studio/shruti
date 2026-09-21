import { IngestGatewayError } from "@ports/app/ingest.js"

/**
 * How long one item may stay non-terminal before the live poll stops asking
 * about it. Not a deadline on the INGEST — the orchestrator keeps working and
 * sync stays authoritative — only on the poll, which is a nicety. Generous:
 * a long lecture downloaded and transcribed end to end is minutes of work.
 */
const GIVE_UP_AFTER_MS = 30 * 60_000

/** Consecutive failed status reads before an item is silenced. */
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * How long a failure run silences an item before it is tried again. Five
 * strikes at the poll cadence is six to fifteen seconds offline — a lift, a
 * tunnel — so the run buys quiet rather than a verdict; the age-out above is
 * what ends the polling for good.
 */
const FAILURE_COOLDOWN_MS = 60_000

/**
 * A status read that will fail the same way forever: the orchestrator has no
 * such run (404), or refuses to answer for it (403/410). Retrying is waste, so
 * these give up at once instead of serving out the failure budget.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof IngestGatewayError)) return false
  return error.status === 404 || error.status === 403 || error.status === 410
}

interface WatchEntry {
  since: number
  failures: number
  retryAt?: number
}

export interface ActiveSelection {
  /** Ids worth asking about on this tick. */
  readonly active: readonly string[]
  /** An item was abandoned or cooled down while selecting. */
  readonly gaveUp: boolean
}

/**
 * Per-item bookkeeping for the live ingest poll: how long an item has been
 * watched, how many reads in a row have failed, and whether it is sleeping off
 * a failure run. An item that ages out or proves permanently unanswerable is
 * abandoned and never asked about again for the life of the watchlist.
 */
export interface IngestPollWatchlist {
  selectActive(ids: readonly string[], now: number): ActiveSelection
  noteSuccess(id: string): void
  /** Returns true when the item stopped being polled — abandoned or cooled down. */
  noteFailure(id: string, error: unknown, now: number): boolean
  clear(): void
}

export function createIngestPollWatchlist(): IngestPollWatchlist {
  const watched = new Map<string, WatchEntry>()
  const abandoned = new Set<string>()

  /** Terminal: the item is not asked about again for the rest of the session. */
  function abandon(id: string, reason: string): void {
    abandoned.add(id)
    watched.delete(id)
    console.warn(`[ingest] giving up on live status for ${id}: ${reason}`)
  }

  /**
   * Reversible: the failure run is spent, so the item sits out the cooldown and
   * is then retried with a fresh budget. Its give-up clock keeps running, so an
   * item that only ever fails still ages out rather than cycling forever.
   */
  function coolDown(entry: WatchEntry, id: string, now: number, reason: string): void {
    entry.failures = 0
    entry.retryAt = now + FAILURE_COOLDOWN_MS
    console.warn(
      `[ingest] pausing live status for ${id} for ${Math.round(FAILURE_COOLDOWN_MS / 1000)}s: ${reason}`
    )
  }

  function registerAndAgeOut(ids: readonly string[], now: number): boolean {
    let gaveUp = false
    for (const id of ids) {
      const seen = watched.get(id)
      if (!seen) watched.set(id, { since: now, failures: 0 })
      else if (now - seen.since > GIVE_UP_AFTER_MS) {
        abandon(id, `no terminal state in ${Math.round(GIVE_UP_AFTER_MS / 60_000)}min`)
        gaveUp = true
      }
    }
    return gaveUp
  }

  function selectActive(ids: readonly string[], now: number): ActiveSelection {
    const pending = ids.filter((id) => !abandoned.has(id))
    // Drop bookkeeping for items that left the pending set (finished, removed,
    // or wiped) so neither collection grows with the session.
    const live = new Set(pending)
    for (const id of watched.keys()) if (!live.has(id)) watched.delete(id)

    const gaveUp = registerAndAgeOut(pending, now)
    // Items sleeping off a failure run are skipped, not dropped: they come back
    // on the first tick after their cooldown expires.
    const active = pending.filter((id) => {
      if (abandoned.has(id)) return false
      const seen = watched.get(id)
      return !seen?.retryAt || seen.retryAt <= now
    })
    return { active, gaveUp }
  }

  function noteSuccess(id: string): void {
    const seen = watched.get(id)
    if (!seen) return
    // A read that answered clears the run AND its cooldown: the control plane
    // is reachable again, which is what the failure budget was asking.
    seen.failures = 0
    delete seen.retryAt
  }

  function noteFailure(id: string, error: unknown, now: number): boolean {
    if (isPermanentFailure(error)) {
      abandon(id, `status read failed permanently (${String(error)})`)
      return true
    }
    const seen = watched.get(id)
    if (!seen) return false
    seen.failures += 1
    if (seen.failures < MAX_CONSECUTIVE_FAILURES) return false
    coolDown(seen, id, now, `${MAX_CONSECUTIVE_FAILURES} consecutive failed status reads`)
    return true
  }

  function clear(): void {
    watched.clear()
    abandoned.clear()
  }

  return { selectActive, noteSuccess, noteFailure, clear }
}
