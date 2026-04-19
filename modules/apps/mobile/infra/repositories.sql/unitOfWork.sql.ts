import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"

/**
 * Wraps IUnitOfWork.run() around IDatabase.transaction(). Callers hand in
 * an async callback; the underlying SQLite transaction commits on return
 * and rolls back on throw.
 */
export function createSqlUnitOfWork(db: IDatabase): IUnitOfWork {
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let captured: T
      await db.transaction(async () => {
        captured = await fn()
      })
      // The transaction callback resolves only after COMMIT; captured is set.
      return captured!
    },
  }
}
