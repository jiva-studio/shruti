import type { ISyncClient } from "@lib/contracts"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { changeToDoc, isChatCollection, isSyncedCollection, mergeChange } from "./mergeRouting.js"

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
  /**
   * The account this cycle pulls for. Pull is not scoped by it — the server
   * derives scope from the bearer — it is only the identity the merge is
   * allowed to write under. Omitted ⇒ unchecked (tests, non-auth callers).
   */
  readonly ownerId?: string | null
  /**
   * The identity live on the device right now, re-read around every network
   * round-trip (#1828). A page requested as one account and merged as another
   * writes the departed account's rows into the database the sign-out wipe
   * just emptied. When it moves, the page is discarded and `pull_cursor` is
   * left where it was, so the next cycle re-requests the same span under the
   * identity that owns the device.
   */
  readonly getLiveOwnerId?: () => string | null
  /**
   * Device-local "Sync chats" gate (default ON), the same provider the journal
   * decorator reads. Off means chat does not sync in EITHER direction (#1848):
   * gating only the upload still delivered every conversation started on the
   * user's other devices.
   */
  readonly isChatSyncEnabled?: () => boolean
  /**
   * Lowest cursor at which a chat change was passed over while the toggle was
   * off, or `null` when there is no outstanding gap. The cursor is global and
   * advances over skipped rows, so without this watermark re-enabling the
   * toggle could never bring those conversations back — the server never
   * compacts them, but nothing would ever ask for them again.
   */
  readonly getChatGapCursor?: () => Promise<number | null>
  /** Persist the gap watermark; `null` clears it. */
  readonly setChatGapCursor?: (cursor: number | null) => Promise<void>
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
  /** Set when a page was thrown away because the device changed hands. */
  let aborted = false
  const chatEnabled = deps.isChatSyncEnabled?.() ?? true
  /** The outstanding chat gap as this cycle found it. */
  const gapBefore = (await deps.getChatGapCursor?.()) ?? null
  /** Cursor at the first page this cycle skipped a chat change on. */
  let skippedAt: number | null = null
  /** Set when pagination ran out of pages rather than being cut short — the
   *  only proof that everything from the gap onwards has now been re-pulled. */
  let caughtUp = false

  // Re-enabled with a gap outstanding: rewind to the floor so the skipped span
  // is walked again. Rewinding below `acked_seq` is safe — the ack is a
  // compaction hint the server never acts on destructively, and it is only
  // re-sent when the cursor climbs past it again.
  if (chatEnabled && gapBefore !== null) {
    const cursor = await deps.syncState.getPullCursor()
    if (gapBefore < cursor) {
      await deps.unitOfWork.run(() => deps.syncState.setPullCursor(gapBefore))
    }
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!ownerIsCurrent(deps)) {
      aborted = true
      break
    }
    const cursor = await deps.syncState.getPullCursor()
    // Captured as close to the transport's own token resolution as the use
    // case can get; compared again below, when the merge is about to open.
    const ownerAtRequest = deps.getLiveOwnerId?.() ?? null
    const res = await deps.gateway.pull({ cursor, limit })
    if (deps.getLiveOwnerId && deps.getLiveOwnerId() !== ownerAtRequest) {
      // The identity moved across the round-trip — sign-out, account deletion,
      // or a "clear user data" that emptied the tables this page would refill.
      // Drop the page whole and leave `pull_cursor` unadvanced: nothing local
      // is deleted or rewritten, and the span is re-requested next cycle under
      // whoever owns the device then.
      aborted = true
      break
    }

    if (res.changes.length > 0) {
      await deps.unitOfWork.run(async () => {
        for (const change of res.changes) {
          // A change for a collection this lane doesn't own (e.g. a future one)
          // is skipped — the routing table stays extensible.
          if (!isSyncedCollection(change.collection)) continue
          if (!chatEnabled && isChatCollection(change.collection)) {
            // "Sync chats" is off on this device: the conversation is not
            // written. Remember where the skipping started so re-enabling can
            // rewind to it — the cursor below advances over these rows and the
            // server would never offer them again.
            if (skippedAt === null) skippedAt = cursor
            continue
          }
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

    if (!res.has_more) {
      caughtUp = true
      break
    }
  }

  // The gap watermark is a FLOOR, and it is cleared only once a full re-pull
  // from it has completed. Taking the newer skip point instead would let a
  // second off→on cycle overwrite the earlier, lower gap and strand the first
  // period's conversations for good.
  if (!chatEnabled && skippedAt !== null) {
    const floor = gapBefore === null ? skippedAt : Math.min(gapBefore, skippedAt)
    if (floor !== gapBefore) await deps.setChatGapCursor?.(floor)
  } else if (chatEnabled && gapBefore !== null && caughtUp) {
    await deps.setChatGapCursor?.(null)
  }

  // Acknowledge the applied cursor once, for compaction. Best-effort ordering:
  // the network ack happens outside the DB transaction; the local `acked_seq`
  // is only advanced after the server confirms. A failed ack is swallowed — it
  // is a compaction hint, not a correctness requirement, and throwing here
  // discarded the merge this cycle already did (#1725). `acked_seq` stays put,
  // so a later cycle re-acks at the then-current cursor.
  const cursor = await deps.syncState.getPullCursor()
  const acked = await deps.syncState.getAckedSeq()
  // An aborted cycle acks nothing: the ack is a per-device compaction hint on
  // the account the bearer resolves to, and that is no longer the account this
  // cursor describes.
  if (!aborted && cursor > acked) {
    try {
      await deps.gateway.ackCursor({ device_id: deviceId, acked_seq: cursor })
      await deps.unitOfWork.run(() => deps.syncState.setAckedSeq(cursor))
    } catch {
      // Deliberately ignored — see above.
    }
  }

  return { applied, changedCollections: [...changed] }
}

/** Whether the account the cycle started for still owns the device. Unchecked
 *  (⇒ `true`) unless the caller wired both halves of the identity. */
function ownerIsCurrent(deps: PullAndMergeDeps): boolean {
  if (!deps.getLiveOwnerId || deps.ownerId === undefined) return true
  return deps.getLiveOwnerId() === (deps.ownerId ?? null)
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(1000, Math.floor(limit)))
}
