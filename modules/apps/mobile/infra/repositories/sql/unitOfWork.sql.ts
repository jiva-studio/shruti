import type { IDatabase } from "@ports/app/index.js"
import type { ITransaction, IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { runInTransaction } from "@kit/persistence"
import { newTransaction, runInSavepoint, type OpenTransactions } from "./transactionScope.js"

/**
 * Wraps IUnitOfWork.run() around IDatabase.transaction(). Callers hand in
 * an async callback; the underlying SQLite transaction commits on return
 * and rolls back on throw.
 *
 * Every un-nested `run` goes to `db.transaction`, which the adapters serialise
 * through their own queue, so it can never be spliced into somebody else's. A
 * call that presents a handle this instance still has open joins that
 * transaction under a savepoint — the same rule as
 * {@link createReentrantUnitOfWork}, kept here only so a nested call can never
 * dead-lock on a nested `BEGIN`; nothing wired to this unit of work nests
 * today.
 *
 * The difference from its reentrant counterpart is now just the extra
 * serialisation queue that one keeps in front of the adapter's own.
 */
export function createSqlUnitOfWork(db: IDatabase): IUnitOfWork {
  const open: OpenTransactions = new Set()

  return {
    async run<T>(fn: (tx?: ITransaction) => Promise<T>, tx?: ITransaction): Promise<T> {
      if (tx && open.has(tx)) return runInSavepoint(db, tx, fn)
      const scope = newTransaction()
      open.add(scope)
      try {
        return await runInTransaction(db, () => fn(scope))
      } finally {
        open.delete(scope)
      }
    },
  }
}
