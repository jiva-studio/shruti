import type { SQLiteDBConnection } from "@capacitor-community/sqlite"
import type { IDatabase, QueryParams } from "@ports/app/index.js"

/**
 * An open plugin connection as an {@link IDatabase}.
 *
 * SQLite has no nested transactions: two overlapping `transaction()` callers
 * on one connection would issue `BEGIN` inside an open transaction. Blocks are
 * therefore serialised through a promise chain, so each runs atomically
 * end-to-end. `execute()` is deliberately NOT queued — repositories call it
 * from inside `fn()`, and routing it through the same chain would dead-lock.
 *
 * The price of that bypass is that a write issued while an unrelated block is
 * open joins it and is rolled back with it. Closing it here would mean
 * threading a transaction handle through every `execute` call site, so the
 * invariant is enforced one layer up instead: a repository write either runs
 * inside a transaction the caller opened, or goes through `IUnitOfWork.run`,
 * which queues it here and gives it a block of its own.
 */
export function createCapacitorDatabase(
  db: SQLiteDBConnection,
  closeConnection: () => Promise<void>
): IDatabase {
  let txQueue: Promise<unknown> = Promise.resolve()

  return {
    async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
      const result = await db.query(sql, params as unknown[])
      return (result.values ?? []) as T[]
    },

    async execute(sql: string, params?: QueryParams): Promise<void> {
      await db.run(sql, params as unknown[], false)
    },

    async transaction(fn: () => Promise<void>): Promise<void> {
      const next = txQueue.then(async () => {
        await db.beginTransaction()
        try {
          await fn()
          await db.commitTransaction()
        } catch (error) {
          // Rollback can itself throw (begin failed, connection gone), which
          // would mask the real error. Isolate it and rethrow the ORIGINAL.
          try {
            await db.rollbackTransaction()
          } catch {
            // Swallow: the original error is what the caller cares about.
          }
          throw error
        }
      })
      // Keep the queue alive even if this block throws, so subsequent callers
      // don't inherit the rejection.
      txQueue = next.catch(() => undefined)
      await next
    },

    async save(): Promise<void> {},

    async close(): Promise<void> {
      await db.close()
      await closeConnection()
    },
  }
}

/**
 * Per-connection pragmas, applied BEST-EFFORT. `foreign_keys` is OFF by
 * default on every SQLite connection, so the schema's `ON DELETE CASCADE`s
 * would silently no-op; it must be set outside a transaction. `busy_timeout`
 * makes a contended write wait instead of throwing "database is locked".
 *
 * The prebuilt content database is opened read-only and the plugin rejects a
 * `run` on a read-only connection. It needs neither pragma, so the failure is
 * swallowed; the writable user database still applies them.
 */
export async function applyConnectionPragmas(db: SQLiteDBConnection): Promise<void> {
  try {
    await db.run("PRAGMA foreign_keys = ON", [], false)
    await db.run("PRAGMA busy_timeout = 3000", [], false)
  } catch {
    // Read-only connection — pragmas don't apply and aren't needed.
  }
}
