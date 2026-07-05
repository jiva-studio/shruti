import type { ISyncClient } from "@lib/contracts"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { changeToDoc, isSyncedCollection, mergeChange } from "./mergeRouting.js"

/** Default page size the client asks for; the server clamps to its own max. */
const DEFAULT_LIMIT = 200
/** Safety bound on pagination so a runaway `has_more` can't loop forever. */
const MAX_PAGES = 100

export interface PullAndMergeDeps {
  readonly gateway: ISyncClient
  readonly syncState: ISyncStateRepository
  readonly apply: ISyncApplyRepository
  readonly unitOfWork: IUnitOfWork
  /** Page size to request (clamped to a sane range). */
  readonly limit?: number
}

export interface PullAndMergeResult {
  /** Number of remote changes applied across all pages. */
  readonly applied: number
  /** Distinct collections touched — the caller refreshes their stores. */
  readonly changedCollections: readonly string[]
}

/**
 * Pull remote changes since the local cursor, merge each into `user.db`, and
 * acknowledge the applied cursor for server-side compaction.
 *
 * Per the design: the client pulls **all** collections under one monotonic
 * cursor (total order → parent-before-child), routes each change by collection
 * to its domain merge rule, and upserts / tombstones the local row **inside
 * one reentrant unit-of-work** (so a page applies atomically). Remote writes go
 * through {@link ISyncApplyRepository} — NOT the journaling repositories — so a
 * pulled change is never echoed back into the outbox.
 *
 * The merge is against the current local doc (its known HLC = the higher of any
 * pending outbox change and the last recorded server HLC), so a concurrent
 * local edit is not silently clobbered by an older remote one. The server HLC
 * pointer advances to the pulled change's HLC regardless of who won, which
 * becomes the `base_hlc` for this device's next push of that doc.
 */
export async function pullAndMerge(deps: PullAndMergeDeps): Promise<PullAndMergeResult> {
  const limit = clampLimit(deps.limit)
  const deviceId = await deps.syncState.getDeviceId()
  const changed = new Set<string>()
  let applied = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const cursor = await deps.syncState.getPullCursor()
    const res = await deps.gateway.pull({ cursor, limit })

    if (res.changes.length > 0) {
      await deps.unitOfWork.run(async () => {
        for (const change of res.changes) {
          // A change for a collection this lane doesn't own (e.g. the chat
          // lane) is skipped — the routing table stays extensible.
          if (!isSyncedCollection(change.collection)) continue
          const remote = changeToDoc(change)
          const local = await deps.apply.getLocalDoc(change.collection, change.doc_id)
          const merged = local ? mergeChange(change.collection, local, remote) : remote
          await deps.apply.applyRemote(change.collection, merged, remote.hlc)
          changed.add(change.collection)
          applied++
        }
        await deps.syncState.setPullCursor(res.cursor)
      })
    } else if (res.cursor > cursor) {
      // Empty page but the cursor advanced (the whole page was our own,
      // echo-suppressed). Advance so we don't re-request the same span.
      await deps.unitOfWork.run(() => deps.syncState.setPullCursor(res.cursor))
    }

    if (!res.has_more) break
  }

  // Acknowledge the applied cursor once, for compaction. Best-effort ordering:
  // the network ack happens outside the DB transaction; the local `acked_seq`
  // is only advanced after the server confirms.
  const cursor = await deps.syncState.getPullCursor()
  const acked = await deps.syncState.getAckedSeq()
  if (cursor > acked) {
    await deps.gateway.ackCursor({ device_id: deviceId, acked_seq: cursor })
    await deps.unitOfWork.run(() => deps.syncState.setAckedSeq(cursor))
  }

  return { applied, changedCollections: [...changed] }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(1000, Math.floor(limit)))
}
