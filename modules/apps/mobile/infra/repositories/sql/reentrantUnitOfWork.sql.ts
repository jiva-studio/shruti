import type { IDatabase } from "@ports/app/index.js"
import type { ITransaction, IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { runInTransaction } from "@kit/persistence"
import { newTransaction, runInSavepoint, type OpenTransactions } from "./transactionScope.js"

/**
 * A {@link IUnitOfWork} that a nested `run` can safely join — where "nested"
 * means *carrying this transaction's handle*, not merely *overlapping it in
 * time*.
 *
 * SQLite has no nested transactions, and the persistence adapters serialise
 * `transaction()` calls through a promise chain — so a second `BEGIN` issued
 * from *inside* an open transaction on the same connection would dead-lock
 * (the outer block awaits the inner, the inner waits its turn in the queue).
 *
 * The sync-journal decorator wants to wrap each domain write plus its outbox
 * entry in one transaction, but those same writes are also called from use
 * cases that ALREADY opened a transaction (`addTrackToPlaylist`,
 * `deleteNote`, …). Sharing one reentrant unit-of-work between the repository
 * bundle and the decorator lets the inner `run` join the caller's transaction
 * instead of opening a second one — so the journal stays atomic with the
 * write.
 *
 * The join is decided by the handle {@link ITransaction} that `run` passes to
 * its callback and the caller passes back down (through a repository method's
 * trailing `tx` argument). Presenting a handle that is still open here is the
 * only proof of nesting there is: it can only have come from the callback of
 * the very transaction it identifies. Everything else — including a `run`
 * issued from an unrelated call stack while this one is mid-flight — is
 * serialised into a transaction of its own, exactly as
 * `createSqlUnitOfWork` would.
 *
 * (The previous implementation used a bare depth counter, raised for the whole
 * duration of any top-level `run`. A concurrent `run` from an unrelated stack
 * was then misread as nested, executed inline inside the foreign transaction,
 * resolved successfully to its caller and discarded on that transaction's
 * rollback — #1493.)
 */
export function createReentrantUnitOfWork(db: IDatabase): IUnitOfWork {
  const open: OpenTransactions = new Set()
  let tail: Promise<unknown> = Promise.resolve()

  function runExclusive<T>(fn: (tx?: ITransaction) => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      const tx = newTransaction()
      open.add(tx)
      try {
        return await runInTransaction(db, () => fn(tx))
      } finally {
        open.delete(tx)
      }
    })
    // Keep the queue alive even if this transaction rejects, so a later
    // caller doesn't inherit the rejection.
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result as Promise<T>
  }

  return {
    run<T>(fn: (tx?: ITransaction) => Promise<T>, tx?: ITransaction): Promise<T> {
      // Called from inside a transaction this unit of work still has open —
      // join it (under a savepoint) instead of dead-locking on a nested BEGIN.
      if (tx && open.has(tx)) return runInSavepoint(db, tx, fn)
      return runExclusive(fn)
    },
  }
}
