import type { LibraryItem, LibraryItemStatus } from "@lib/domain/libraryItem.js"

/**
 * Cadence policy for the profile-sync engine's poll loop (personal library,
 * epic #1236). The flat 3-minute foreground interval is fine at rest but far
 * too slow to reflect a freshly-added lecture flipping `processing → ready`:
 * ingest lands on the server seconds-to-minutes later and the projection is
 * pull-only, so the device only sees it on the next pull.
 *
 * While ANY `library_item` is still `queued`/`processing` we therefore poll on
 * a short, self-backing-off cadence (start `PENDING_SYNC_MIN_MS`, double each
 * cycle up to `PENDING_SYNC_MAX_MS`) so "ready" surfaces quickly without
 * hammering the endpoint for a slow transcription. When nothing is pending we
 * fall back to the idle interval.
 *
 * The functions here are PURE so the schedule is unit-testable in isolation
 * from the timer / repo plumbing in `useSyncEngine`.
 */

/** Idle foreground cadence — a full sync cycle at rest. */
export const IDLE_SYNC_INTERVAL_MS = 3 * 60 * 1000
/** First short-poll delay once something becomes pending. */
export const PENDING_SYNC_MIN_MS = 5 * 1000
/** Upper bound of the pending short-poll backoff. */
export const PENDING_SYNC_MAX_MS = 60 * 1000

const PENDING_STATUSES: ReadonlySet<LibraryItemStatus> = new Set<LibraryItemStatus>([
  "queued",
  "processing",
])

/** A library item still working through ingest (server will update it). */
export function isPendingLibraryItem(item: Pick<LibraryItem, "status">): boolean {
  return PENDING_STATUSES.has(item.status)
}

/** True when at least one item is still being ingested. */
export function hasPendingLibraryItems(items: readonly Pick<LibraryItem, "status">[]): boolean {
  return items.some(isPendingLibraryItem)
}

/**
 * The delay before the next poll cycle.
 *
 * - `hasPending === false` → the flat idle interval.
 * - `hasPending === true` → a short backoff: `PENDING_SYNC_MIN_MS` on the first
 *   pending cycle (`prevPendingDelayMs === null`, i.e. we were idle before),
 *   then double each subsequent pending cycle, capped at `PENDING_SYNC_MAX_MS`.
 *
 * Pass the previous return value back as `prevPendingDelayMs` ONLY while still
 * pending; reset it to `null` whenever a cycle finds nothing pending so the
 * next pending run starts fast again.
 */
export function nextSyncDelayMs(hasPending: boolean, prevPendingDelayMs: number | null): number {
  if (!hasPending) return IDLE_SYNC_INTERVAL_MS
  if (prevPendingDelayMs === null) return PENDING_SYNC_MIN_MS
  return Math.min(prevPendingDelayMs * 2, PENDING_SYNC_MAX_MS)
}
