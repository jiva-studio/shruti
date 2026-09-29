/**
 * @usecases/sync — the profile sync engine.
 *
 * Orchestrates pull → merge → push over the domain merge rules
 * (`@lib/domain/sync`), the outbox / sync-state / apply ports
 * (`@lib/domain/ports`), and the transport gateway (`@lib/contracts`,
 * `ISyncClient`). Pure application layer: no Vue, no `@infra`, no platform IO.
 */
export { runSync } from "./runSync.js"
export type { RunSyncDeps, RunSyncResult } from "./runSync.js"

export type { PullAndMergeDeps, PullAndMergeResult } from "./pullAndMerge.js"
export { pushLocal } from "./pushLocal.js"
export type { PushLocalDeps, PushLocalResult } from "./pushLocal.js"

export { backfillLocal } from "./backfillLocal.js"
export { createBackfillGuard } from "./backfillGuard.js"
export type { BackfillDeps, BackfillGuard } from "./backfillGuard.js"
export { createCursorOwnerGuard } from "./cursorOwnerGuard.js"
export type { CursorOwnerDeps } from "./cursorOwnerGuard.js"
export { createChatGapCursor } from "./chatGapStore.js"
export type { ChatGapCursor } from "./chatGapStore.js"
export type { ISyncMarkerStore, SyncEngineRepositories } from "./syncEnginePorts.js"
export type { BackfillLocalDeps, BackfillLocalResult } from "./backfillLocal.js"
export { adoptAnonymousChanges } from "./adoptAnonymousChanges.js"
export type {
  AdoptAnonymousChangesDeps,
  AdoptAnonymousChangesResult,
} from "./adoptAnonymousChanges.js"
export {
  isPendingLibraryItem,
  hasPendingLibraryItems,
  nextSyncDelayMs,
} from "./libraryPendingSchedule.js"
