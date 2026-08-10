import type { IDatabase } from "@ports/app/index.js"
import type { ITransaction } from "@lib/domain/ports/unitOfWork.js"

/**
 * Shared machinery for binding a transaction to an execution context.
 *
 * A unit of work keeps the handles of the transactions it currently has open
 * in an {@link OpenTransactions} set. `run(fn, tx)` joins only when `tx` is one
 * of them — object identity, so a handle from another unit of work, or from a
 * transaction that has already finished, can never splice a write into an
 * unrelated block. Everything else opens a transaction of its own.
 */
export type OpenTransactions = Set<ITransaction>

let savepointSeq = 0

/** A fresh, unforgeable handle for one transaction. */
export function newTransaction(): ITransaction {
  return { kind: "transaction" }
}

/**
 * Runs a JOINED callback inside a SQLite `SAVEPOINT`, so the joined block is
 * atomic *within* the transaction it joined: its writes are undone on throw
 * instead of riding along to the outer `COMMIT` (#1493's second harm mode — a
 * failed journal entry used to leave the domain write committed without it).
 *
 * `RELEASE` is the savepoint's commit; `ROLLBACK TO` + `RELEASE` undoes it and
 * pops it. Both are plain statements on the open connection — no `BEGIN`, so
 * nothing here can dead-lock against the adapter's transaction queue.
 */
export async function runInSavepoint<T>(
  db: IDatabase,
  tx: ITransaction,
  fn: (tx?: ITransaction) => Promise<T>
): Promise<T> {
  const name = `uow_sp_${++savepointSeq}`
  await db.execute(`SAVEPOINT ${name}`)
  try {
    const value = await fn(tx)
    await db.execute(`RELEASE ${name}`)
    return value
  } catch (error) {
    try {
      await db.execute(`ROLLBACK TO ${name}`)
      await db.execute(`RELEASE ${name}`)
    } catch {
      // Swallow: the original error is what the caller cares about, and an
      // outer ROLLBACK is coming anyway if nobody catches it.
    }
    throw error
  }
}
