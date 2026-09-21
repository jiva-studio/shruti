import type { Conflict, ISyncClient, PushItem } from "@lib/contracts"
import type { IOutboxRepository, OutboxEntry } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { hlcNow, hlcToString, parseHlc } from "@lib/domain"
import { changeToDoc, isSyncedCollection, mergeChange, outboxToDoc } from "./mergeRouting.js"
import {
  higherHlc,
  latestPendingForKey,
  refKey,
  settlePushedRows,
  type Settlement,
} from "./pushSettlement.js"

/** Max pending rows per push (keeps the request within the edge body cap). */
const PUSH_BATCH = 200
/** Bound on conflict re-merge rounds so a pathological ping-pong can't loop. */
const MAX_ROUNDS = 5

export interface PushLocalDeps {
  readonly gateway: ISyncClient
  readonly outbox: IOutboxRepository
  readonly apply: ISyncApplyRepository
  readonly syncState: ISyncStateRepository
  readonly unitOfWork: IUnitOfWork
  /** The account this drain belongs to — only rows it journaled are read. */
  readonly ownerId?: string | null
  /**
   * The identity live on the device right now. `ownerId` decides which local
   * rows are read; this decides whether uploading them is still legitimate.
   * The transport resolves a bearer token per request, so a drain that began
   * as one account would otherwise keep POSTing its rows after the device
   * switched — landing them in the new account. Checked before every round
   * AND again immediately before the request itself: reconciling `base_hlc`
   * is a run of awaits, and the identity can change inside it (#1828). When
   * it no longer matches, the drain stops and the next cycle re-runs it under
   * the right identity. Omitted ⇒ unchecked (tests, non-auth callers).
   */
  readonly getLiveOwnerId?: () => string | null
}

export interface PushLocalResult {
  /** Number of changes the server acknowledged as applied. */
  readonly pushed: number
  /** Number of conflicts re-merged and re-journaled. */
  readonly conflicts: number
  /** Collections whose local rows changed via a conflict re-merge. */
  readonly changedCollections: readonly string[]
}

/**
 * Drain the local outbox to the `profile` service, reconciling `base_hlc` and
 * re-merging any optimistic-concurrency conflicts.
 *
 * For each pending change the `base_hlc` — the last server HLC this device saw
 * for that doc — is read from {@link ISyncApplyRepository.lastServerHlc}
 * (`""` ⇒ the doc is new). The server applies a change iff its `base_hlc`
 * matches the current master; otherwise it returns the master under
 * `conflicts` and this engine:
 *   1. merges the master with the local change by the collection's domain rule,
 *   2. applies the merged doc to the local row (so the device converges now),
 *   3. re-journals it as a fresh outbox row stamped with a new HLC (strictly
 *      greater than the master, so it moves the doc forward) and
 *      `base_hlc = master.hlc`, which the next round pushes and the server
 *      accepts.
 *
 * Idempotent + re-runnable: every pushed row is marked `sent` only after the
 * server responds, so a crashed / retried push re-sends the same rows (the
 * server dedupes on `(user, collection, doc, hlc)`), and an all-sent outbox
 * makes a re-run a no-op.
 *
 * Compacting: each round drops the rows its own acknowledgement superseded
 * (#1798) — the journal used to grow monotonically for the life of the
 * install. Only rows a NEWER acknowledged row replaces go; see
 * `IOutboxRepository.prune` for why the newest row of every document stays.
 *
 * Scoped to `ownerId`: a row journaled by another account is never read, so a
 * deleted account's un-pushed changes (which a local wipe leaves behind) are
 * not uploaded under the identity that replaces it. Rows predating the owner
 * stamp fall back to the `sync_state.pushed_outbox_id` watermark.
 */
export async function pushLocal(deps: PushLocalDeps): Promise<PushLocalResult> {
  const deviceId = await deps.syncState.getDeviceId()
  const changed = new Set<string>()
  let pushed = 0
  let conflicts = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The device may have changed hands since the cycle started — mid-drain,
    // even, since each round is its own network round-trip. Stop rather than
    // POST this account's rows under the token the new one now supplies.
    if (ownerMoved(deps)) break

    // Re-read each round: the previous round raised it, and an identity change
    // may have jumped it past the whole journal.
    const pending = await deps.outbox.listPending(PUSH_BATCH, {
      ownerId: deps.ownerId,
      afterId: await deps.syncState.getPushedOutboxId(),
    })
    if (pending.length === 0) break

    const items = await reconcileBaseHlc(deps, pending)

    // Last look before the batch leaves the device. The transport resolves its
    // bearer inside the request, so this is as close to the token as the use
    // case can stand — and it has to be BEFORE, not after: un-marking rows on
    // a post-response check would break push idempotency and double-upload.
    if (ownerMoved(deps)) break

    const res = await deps.gateway.push({ device_id: deviceId, changes: items })
    pushed += res.applied.length
    conflicts += res.conflicts.length

    const conflictByKey = new Map(
      res.conflicts.map((c) => [refKey(c.collection, c.doc_id), c] as const)
    )
    const settled = settlePushedRows(
      pending,
      new Set(res.applied.map((r) => refKey(r.collection, r.doc_id))),
      new Set(conflictByKey.keys())
    )

    await deps.unitOfWork.run(async () => {
      for (const entry of settled.applied) {
        // The pushed change landed — it is now the doc's server master.
        await deps.apply.recordServerHlc(entry.collection, entry.docId, entry.hlc)
      }
      for (const collection of await remergeConflicts(deps, deviceId, pending, conflictByKey)) {
        changed.add(collection)
      }
      await commitSettlement(deps, settled)
    })

    // No conflicts → nothing was re-journaled. A FULL batch still has rows
    // behind it, though, so only a short one means the outbox is drained.
    if (res.conflicts.length === 0 && pending.length < PUSH_BATCH) break
  }

  return { pushed, conflicts, changedCollections: [...changed] }
}

/** Whether the identity that owns this drain has stopped owning the device.
 *  Unchecked (⇒ `false`) unless the caller wired the live reader. */
function ownerMoved(deps: PushLocalDeps): boolean {
  const read = deps.getLiveOwnerId
  return read !== undefined && read() !== (deps.ownerId ?? null)
}

/**
 * The batch to POST. A journaled row leaves `base_hlc` NULL and takes the
 * doc's recorded master. An explicit `""` is a claim the row descends from
 * nothing this ACCOUNT has seen — written by the first-sync backfill and by
 * the anonymous handover — and it has to survive a pull that recorded a master
 * in the same cycle: taking that master would fast-forward the server past its
 * own version, whereas an empty base asks for the conflict and resolves it by
 * the collection's merge rule.
 */
async function reconcileBaseHlc(
  deps: PushLocalDeps,
  pending: readonly OutboxEntry[]
): Promise<PushItem[]> {
  const items: PushItem[] = []
  for (const entry of pending) {
    const base =
      entry.baseHlc === ""
        ? ""
        : ((await deps.apply.lastServerHlc(entry.collection, entry.docId)) ?? "")
    items.push({
      collection: entry.collection,
      doc_id: entry.docId,
      op: entry.op,
      data: entry.op === "delete" ? undefined : entry.data,
      hlc: entry.hlc,
      base_hlc: base,
    })
  }
  return items
}

/** Re-merge each conflicted doc exactly once against its local change, and
 *  report the collections whose local rows moved. */
async function remergeConflicts(
  deps: PushLocalDeps,
  deviceId: string,
  pending: readonly OutboxEntry[],
  conflictByKey: ReadonlyMap<string, Conflict>
): Promise<readonly string[]> {
  const changed: string[] = []
  for (const [key, conflict] of conflictByKey) {
    if (!isSyncedCollection(conflict.collection)) continue
    const local = latestPendingForKey(pending, key)
    if (!local) continue
    const master = changeToDoc(conflict.master)
    const merged = mergeChange(conflict.collection, outboxToDoc(local), master)

    // Fresh HLC strictly greater than both our clock tail and the master, so
    // the re-pushed change moves the doc forward rather than tying it.
    const seed = higherHlc(await deps.outbox.latestHlc(), master.hlc)
    const freshHlc = hlcToString(hlcNow(deviceId, parseHlc(seed)))

    // Converge the local row now; applyRemote records master.hlc as the doc's
    // server pointer — the base the re-push will match.
    await deps.apply.applyRemote(conflict.collection, { ...merged, hlc: freshHlc }, master.hlc)
    await deps.outbox.append({
      collection: conflict.collection,
      docId: conflict.doc_id,
      op: merged.deleted ? "delete" : "upsert",
      data: merged.deleted ? null : merged.data,
      hlc: freshHlc,
      baseHlc: master.hlc,
      // This document is the drain's own, re-merged — stamp it explicitly.
      // Left to the adapter's provider it would take whoever owns the device
      // at this instant, handing the row to a stranger if the identity flipped
      // during the round-trip.
      ownerId: deps.ownerId ?? null,
    })
    changed.push(conflict.collection)
  }
  return changed
}

/** Retire the acknowledged rows and compact what they superseded. A row is
 *  dead weight once a NEWER row for its document has been acknowledged too,
 *  and only then; the pass is scoped to this round's documents so it stays
 *  proportional to what changed rather than to the journal's size. */
async function commitSettlement(deps: PushLocalDeps, settled: Settlement): Promise<void> {
  await deps.outbox.markSent([...settled.sentIds])
  // Re-read inside the transaction, not from the pre-network snapshot: the
  // watermark gates reads, so writing back a value raised while the push was
  // in flight would re-expose rows it had already retired.
  const prev = await deps.syncState.getPushedOutboxId()
  if (settled.maxSentId > prev) await deps.syncState.setPushedOutboxId(settled.maxSentId)
  if (settled.sentDocs.length === 0) return
  await deps.outbox.prune({
    watermark: Math.max(prev, settled.maxSentId),
    docs: [...settled.sentDocs],
  })
}
