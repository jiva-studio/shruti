import type { ISyncClient } from "@lib/contracts"
import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { pullAndMerge, type PullAndMergeResult } from "./pullAndMerge.js"
import { pushLocal, type PushLocalResult } from "./pushLocal.js"

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
   * The identity live on the device right now, re-read around every network
   * round-trip on BOTH halves (#1828) — so a drain stops instead of uploading
   * under a token that changed hands, and a pull discards its page instead of
   * merging a departed account's changes back after the sign-out wipe.
   */
  readonly getLiveOwnerId?: () => string | null
  /** Page size for pull (optional; clamped downstream). */
  readonly limit?: number
  /** Device-local "Sync chats" gate (default ON) — pull side (#1848). */
  readonly isChatSyncEnabled?: () => boolean
  /** Chat-gap watermark accessors; see `PullAndMergeDeps`. */
  readonly getChatGapCursor?: () => Promise<number | null>
  readonly setChatGapCursor?: (cursor: number | null) => Promise<void>
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
const NO_PULL: PullAndMergeResult = { applied: 0, changedCollections: [] }
const NO_PUSH: PushLocalResult = { pushed: 0, conflicts: 0, changedCollections: [] }

/**
 * One full sync cycle: **pull → merge → push**.
 *
 * Pull first so the local push carries the freshest `base_hlc` and merges
 * against current server state (minimizing conflicts); then drain the outbox.
 * After a cycle that changed any local rows, the affected stores are refreshed.
 *
 * The two halves are **independent**, so a failing one no longer cancels the
 * other (#1725). Pull-first is an optimization, not an invariant: the server
 * applies a change only when its `base_hlc` matches the master and otherwise
 * returns that master under `conflicts`, which `pushLocal` re-merges by the
 * collection's domain rule — so a stale base costs a conflict round, never a
 * lost write. The asymmetry decides it: a skipped pull loses nothing (the
 * remote changes are still there next cycle), while a skipped push leaves
 * local writes with no second copy anywhere. The first error is re-thrown
 * after both halves have run, so the caller still sees a failed cycle.
 *
 * Guarded: a `null` gateway (a region without `profileBaseUrl`) makes this a
 * no-op. This is defense-in-depth — the trigger composable already gates on the
 * same conditions and simply doesn't call `runSync` when disabled.
 */
export async function runSync(deps: RunSyncDeps): Promise<RunSyncResult> {
  if (!deps.gateway) return SKIPPED

  let failure: unknown = null
  let pull = NO_PULL
  try {
    pull = await pullAndMerge({
      gateway: deps.gateway,
      syncState: deps.syncState,
      apply: deps.apply,
      unitOfWork: deps.unitOfWork,
      limit: deps.limit,
      ownerId: deps.ownerId,
      getLiveOwnerId: deps.getLiveOwnerId,
      isChatSyncEnabled: deps.isChatSyncEnabled,
      getChatGapCursor: deps.getChatGapCursor,
      setChatGapCursor: deps.setChatGapCursor,
    })
  } catch (err) {
    failure = err
  }

  let push = NO_PUSH
  try {
    push = await pushLocal({
      gateway: deps.gateway,
      outbox: deps.outbox,
      apply: deps.apply,
      syncState: deps.syncState,
      unitOfWork: deps.unitOfWork,
      ownerId: deps.ownerId,
      getLiveOwnerId: deps.getLiveOwnerId,
    })
  } catch (err) {
    if (failure === null) failure = err
  }

  // Refreshed even on failure: whatever DID land is already in `user.db`, and
  // the stores don't observe SQLite.
  const changed = new Set<string>([...pull.changedCollections, ...push.changedCollections])
  if (changed.size > 0 && deps.refreshStores) {
    await deps.refreshStores([...changed])
  }

  if (failure !== null) throw failure

  return {
    skipped: false,
    pulled: pull.applied,
    pushed: push.pushed,
    conflicts: push.conflicts,
  }
}
