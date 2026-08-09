import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { runInTransaction } from "@kit/persistence"

/**
 * Wraps IUnitOfWork.run() around IDatabase.transaction(). Callers hand in
 * an async callback; the underlying SQLite transaction commits on return
 * and rolls back on throw.
 *
 * The ISOLATING implementation, and the one to inject wherever a caller must
 * get a transaction of its own: every `run` goes to `db.transaction`, which
 * the adapters serialise through their own queue, so it can never be spliced
 * into somebody else's. Its counterpart, {@link createReentrantUnitOfWork},
 * deliberately gives that up — a nested `run` *joins* the open transaction —
 * which is what the sync-journal decorator needs and what a repository
 * read-modify-write must not have (see the wiring note in `index.ts` and
 * #1493).
 */
export function createSqlUnitOfWork(db: IDatabase): IUnitOfWork {
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return runInTransaction(db, fn)
    },
  }
}
