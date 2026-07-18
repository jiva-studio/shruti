/**
 * @usecases/sync — the profile sync engine (Lane D).
 *
 * Orchestrates pull → merge → push over the domain merge rules
 * (`@lib/domain/sync`), the outbox / sync-state / apply ports
 * (`@lib/domain/ports`), and the transport gateway (`@lib/contracts`,
 * `ISyncClient`). Pure application layer: no Vue, no `@infra`, no platform IO.
 */
export { runSync } from "./runSync.js"
export type { RunSyncDeps, RunSyncResult } from "./runSync.js"
export { pullAndMerge } from "./pullAndMerge.js"
export type { PullAndMergeDeps, PullAndMergeResult } from "./pullAndMerge.js"
export { pushLocal } from "./pushLocal.js"
export type { PushLocalDeps, PushLocalResult } from "./pushLocal.js"
export { isSyncedCollection, changeToDoc, outboxToDoc, mergeChange } from "./mergeRouting.js"
export { backfillLocal } from "./backfillLocal.js"
export type { BackfillLocalDeps, BackfillLocalResult } from "./backfillLocal.js"
export {
  IDLE_SYNC_INTERVAL_MS,
  PENDING_SYNC_MIN_MS,
  PENDING_SYNC_MAX_MS,
  isPendingLibraryItem,
  hasPendingLibraryItems,
  nextSyncDelayMs,
} from "./libraryPendingSchedule.js"
