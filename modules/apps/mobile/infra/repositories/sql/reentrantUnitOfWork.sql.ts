import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { runInTransaction } from "@kit/persistence"

/**
 * A {@link IUnitOfWork} that a nested `run` can safely join.
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
 * bundle and the decorator lets the inner `run` detect the open transaction
 * and execute inline instead of opening a second one — so the journal joins
 * the caller's transaction and stays atomic with the write.
 *
 * Top-level `run` calls are serialised so two independent operations each get
 * their own isolated transaction (matching the adapter's own `txQueue`); the
 * reentrancy flag is only observed by calls issued from within an in-flight
 * transaction's callback.
 */
export function createReentrantUnitOfWork(db: IDatabase): IUnitOfWork {
  let depth = 0
  let tail: Promise<unknown> = Promise.resolve()

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      depth++
      try {
        return await runInTransaction(db, fn)
      } finally {
        depth--
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
    run<T>(fn: () => Promise<T>): Promise<T> {
      // Already inside a transaction opened by this unit-of-work — join it
      // instead of dead-locking on a nested BEGIN.
      if (depth > 0) return fn()
      return runExclusive(fn)
    },
  }
}
