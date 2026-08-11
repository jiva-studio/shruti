import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncBackfillRepository } from "@lib/domain/ports/syncBackfillRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { hlcNow, hlcToString, maxHlcString, parseHlc, type Hlc } from "@lib/domain"

export interface BackfillLocalDeps {
  /** Reader over the un-journaled rows in the synced collections. */
  readonly backfill: ISyncBackfillRepository
  /** The local journal the backfilled rows are enqueued into. */
  readonly outbox: IOutboxRepository
  /** Source of the highest server HLC this device has OBSERVED — the other
   *  half of the stamp seed, see below. */
  readonly apply: Pick<ISyncApplyRepository, "latestServerHlc">
  /** Source of this device's stable id (the HLC tiebreak). */
  readonly syncState: ISyncStateRepository
  /** Reentrant unit-of-work — enumeration + enqueue run in one transaction. */
  readonly unitOfWork: IUnitOfWork
  /**
   * The account whose pre-sync rows these are. Stamped explicitly rather than
   * left to the adapter's live provider, so an identity flip mid-pass cannot
   * hand this account's history to the next one (#1497).
   */
  readonly ownerId?: string | null
}

export interface BackfillLocalResult {
  /** Number of rows enqueued into the outbox this run (0 on a re-run). */
  readonly enqueued: number
  /** Distinct collections that had at least one row backfilled. */
  readonly collections: readonly string[]
}

/**
 * First-sync backfill (Lane E2b).
 *
 * Rows created before journaling existed (or before this device first synced)
 * have **no** outbox entry and **no** `sync_doc_hlc` — the journal decorator
 * never saw them, so they would never upload. The first time the engine runs
 * for an account (anonymous or signed-in), this use case enumerates exactly
 * those rows (via {@link ISyncBackfillRepository}) and enqueues each into the
 * outbox as an `upsert` with `base_hlc = ""` (a new doc) and a freshly stamped,
 * monotonic HLC. The `data` snapshot is produced by the adapter in the **same
 * wire shape the journal decorator writes**, so a backfilled row is
 * byte-identical to a journaled one; the normal push path (`pushLocal`) then
 * uploads them under that account.
 *
 * **Idempotent.** The reader only returns rows with neither an outbox row nor a
 * `sync_doc_hlc` record, so once this pass enqueues a row it drops out of the
 * candidate set — a second run finds nothing and enqueues nothing. The whole
 * pass runs inside the reentrant unit-of-work, so the enqueue is atomic.
 *
 * The engine's `userId`/`profileBaseUrl` gating is the caller's job (the
 * `useSyncEngine` composable): this use case just moves rows into the outbox.
 */
export async function backfillLocal(deps: BackfillLocalDeps): Promise<BackfillLocalResult> {
  return deps.unitOfWork.run(async () => {
    const candidates = await deps.backfill.listUnsynced()
    if (candidates.length === 0) return { enqueued: 0, collections: [] }

    const deviceId = await deps.syncState.getDeviceId()
    // Seed the HLC chain from the highest stamp this device has ISSUED or
    // OBSERVED — the outbox tail and the recorded server pointers. The tail
    // alone leaves a device whose clock trails another one stamping below the
    // remote changes it already holds, which loses the LWW comparison against
    // them (#1628).
    const tail = await deps.outbox.latestHlc()
    const observed = await deps.apply.latestServerHlc()
    const seed = maxHlcString(tail, observed)
    let lastSeen: Hlc | null = seed === null ? null : parseHlc(seed)

    const collections = new Set<string>()
    for (const c of candidates) {
      const stamp = hlcNow(deviceId, lastSeen)
      lastSeen = stamp
      await deps.outbox.append({
        collection: c.collection,
        docId: c.docId,
        op: "upsert",
        data: c.data,
        hlc: hlcToString(stamp),
        // "" ⇒ new doc. push recomputes the real base from `sync_doc_hlc`
        // (absent here), so this simply records "no server ancestor yet".
        baseHlc: "",
        ownerId: deps.ownerId ?? null,
      })
      collections.add(c.collection)
    }

    return { enqueued: candidates.length, collections: [...collections] }
  })
}
