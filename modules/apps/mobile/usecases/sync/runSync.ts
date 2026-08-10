import type { ISyncClient } from "@lib/contracts"
import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { pullAndMerge } from "./pullAndMerge.js"
import { pushLocal } from "./pushLocal.js"

export interface RunSyncDeps {
  /**
   * The transport. **`null` disables the engine** — `runSync` no-ops. The
   * composable never calls `runSync` when there is no `userId` yet or the
   * active region has no `profileBaseUrl`; there is no fallback transport.
   */
  readonly gateway: ISyncClient | null
  readonly outbox: IOutboxRepository
  readonly syncState: ISyncStateRepository
  readonly apply: ISyncApplyRepository
  readonly unitOfWork: IUnitOfWork
  /**
   * The account this cycle runs for. Push reads only the rows it journaled,
   * so a previous owner's un-pushed changes stay local (#1497).
   */
  readonly ownerId?: string | null
  /**
   * The identity live on the device right now, re-read between push rounds so
   * a drain stops instead of uploading under a token that changed hands.
   */
  readonly getLiveOwnerId?: () => string | null
  /** Page size for pull (optional; clamped downstream). */
  readonly limit?: number
  /**
   * Invoked after a sync that changed local rows, with the distinct affected
   * collections, so the caller can refresh the (non-reactive-to-SQLite) Pinia
   * stores. The engine itself stays pure — it never imports a store.
   */
  readonly refreshStores?: (collections: readonly string[]) => void | Promise<void>
}

export interface RunSyncResult {
  /** `true` when the engine was disabled (no gateway) and did nothing. */
  readonly skipped: boolean
  readonly pulled: number
  readonly pushed: number
  readonly conflicts: number
}

const SKIPPED: RunSyncResult = { skipped: true, pulled: 0, pushed: 0, conflicts: 0 }

/**
 * One full sync cycle: **pull → merge → push**.
 *
 * Pull first so the local push carries the freshest `base_hlc` and merges
 * against current server state (minimizing conflicts); then drain the outbox.
 * After a cycle that changed any local rows, the affected stores are refreshed.
 *
 * Guarded: a `null` gateway (a region without `profileBaseUrl`) makes this a
 * no-op. This is defense-in-depth — the trigger composable already gates on the
 * same conditions and simply doesn't call `runSync` when disabled.
 */
export async function runSync(deps: RunSyncDeps): Promise<RunSyncResult> {
  if (!deps.gateway) return SKIPPED

  const pull = await pullAndMerge({
    gateway: deps.gateway,
    syncState: deps.syncState,
    apply: deps.apply,
    unitOfWork: deps.unitOfWork,
    limit: deps.limit,
  })

  const push = await pushLocal({
    gateway: deps.gateway,
    outbox: deps.outbox,
    apply: deps.apply,
    syncState: deps.syncState,
    unitOfWork: deps.unitOfWork,
    ownerId: deps.ownerId,
    getLiveOwnerId: deps.getLiveOwnerId,
  })

  const changed = new Set<string>([...pull.changedCollections, ...push.changedCollections])
  if (changed.size > 0 && deps.refreshStores) {
    await deps.refreshStores([...changed])
  }

  return {
    skipped: false,
    pulled: pull.applied,
    pushed: push.pushed,
    conflicts: push.conflicts,
  }
}
