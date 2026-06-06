import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { runInTransaction } from "@kit/persistence"

/**
 * Wraps IUnitOfWork.run() around IDatabase.transaction(). Callers hand in
 * an async callback; the underlying SQLite transaction commits on return
 * and rolls back on throw.
 */
export function createSqlUnitOfWork(db: IDatabase): IUnitOfWork {
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return runInTransaction(db, fn)
    },
  }
}
