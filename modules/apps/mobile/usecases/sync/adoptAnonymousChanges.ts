import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ITransaction, IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"

export interface AdoptAnonymousChangesDeps {
  readonly outbox: IOutboxRepository
  readonly apply: ISyncApplyRepository
  readonly unitOfWork: IUnitOfWork
  /** The anonymous account the device used until the sign-in. */
  readonly fromOwnerId: string
  /** The account it signed in to — a DIFFERENT id than `fromOwnerId`. */
  readonly toOwnerId: string
  /** See {@link OutboxReattribution.unownedAfterId}; `0` when the device has
   *  never retired a previous identity's journal. */
  readonly unownedAfterId?: number
  /**
   * The caller's open transaction, when this runs from inside one (#1827).
   * `unitOfWork` is SHARED with the rest of the user-database repositories, so
   * a caller that already holds it and omits the handle is not recognised as
   * nested: the inner `run` is queued behind the outer one's own promise and
   * neither can ever finish. Presenting the handle joins the caller's
   * transaction under a savepoint instead.
   */
  readonly tx?: ITransaction
}

export interface AdoptAnonymousChangesResult {
  /** Documents handed over — `0` on a re-run, which is a no-op. */
  readonly docs: number
}

/**
 * Hand the anonymous period's data to the account the user just signed in to
 * (#1627).
 *
 * Signing in from an anonymous session lands on a **different** user id
 * whenever the human already had an account (`auth` cross-links by verified
 * email before it considers upgrading the anonymous one in place). Everything
 * journaled while anonymous is then unreachable: push reads
 * `owner_id = <new id>`, so the anonymous rows are invisible to it, and the
 * first-sync backfill skips exactly those documents because they already own an
 * outbox row and a `sync_doc_hlc`. The rows stay on screen, indistinguishable
 * from synced ones, and exist nowhere but this device.
 *
 * The handover is a **replay, not a re-snapshot**: the journal rows change
 * hands and go back to pending, keeping their original HLCs and payloads, and
 * the normal push carries them up under the new owner in write order. Two
 * consequences worth the choice:
 *
 *  - the new account's own copy of a colliding document (only realistic for
 *    `playlist_items`, whose doc id is the natural `track_id`) is resolved by
 *    the collection's merge rule against the REAL write times. Re-snapshotting
 *    the local rows instead — a second run of the backfill — would stamp them
 *    "now" and hand this device an unconditional win over a newer version
 *    written on another device;
 *  - the anonymous period's deletes survive as deletes.
 *
 * Their `sync_doc_hlc` pointers are dropped in the same transaction: each names
 * a master in the account being left behind, so the replay must push with no
 * base at all (the server applies a document it has never seen, and conflicts
 * on one it has, which is precisely the outcome we want).
 *
 * **Idempotent.** Everything happens in one unit of work, and the scope
 * predicate empties itself: after a run there are no rows left owned by the
 * anonymous id, so a resumed / repeated call finds nothing and touches nothing
 * — including the pointers the push has since re-recorded for the new owner.
 */
export async function adoptAnonymousChanges(
  deps: AdoptAnonymousChangesDeps
): Promise<AdoptAnonymousChangesResult> {
  if (deps.fromOwnerId === deps.toOwnerId) return { docs: 0 }
  // `deps.tx` joins the caller's transaction; without one this opens its own,
  // exactly as before. Both repository calls below use bare statements, so
  // they are safe either way.
  return deps.unitOfWork.run(async () => {
    const refs = await deps.outbox.reattribute({
      fromOwnerId: deps.fromOwnerId,
      toOwnerId: deps.toOwnerId,
      unownedAfterId: deps.unownedAfterId ?? 0,
    })
    if (refs.length === 0) return { docs: 0 }
    await deps.apply.forgetDocHlcs(refs)
    return { docs: refs.length }
  }, deps.tx)
}
