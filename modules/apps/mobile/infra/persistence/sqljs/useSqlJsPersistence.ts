import initSqlJs, { type Database } from "sql.js"
// Bundle the wasm locally via Vite so we don't depend on sql.js.org (which 404s).
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url"
import type { IDatabase, IPersistence, QueryParams } from "@ports/app/index.js"
import { saveData, getBlob } from "@kit/infra"

export function useSqlJsPersistence(): IPersistence {
  return {
    async open(dbName: string): Promise<IDatabase> {
      const SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl,
      })

      const [indexedDbName, storeName, key] = dbName.split("/")
      const dbData = await getBlob(indexedDbName, storeName, key)
      const db: Database = dbData ? new SQL.Database(dbData) : new SQL.Database()

      // SQL.js is single-threaded and SQLite has no nested transactions;
      // overlapping BEGIN calls explode with "cannot start a transaction
      // within a transaction". Serialise transaction-callers through a
      // promise chain so every block runs atomically end-to-end.
      let txQueue: Promise<unknown> = Promise.resolve()
      // While `inTransaction` is true, repo `save()` calls are deferred
      // — the wrapping transaction issues a single `db.export()` after
      // COMMIT. Calling export mid-transaction would close/reopen the
      // database and tear down the active transaction.
      let inTransaction = false
      let saveDeferred = false
      let savePromise: Promise<void> = Promise.resolve()

      async function persistNow(): Promise<void> {
        const data = db.export()
        await saveData(indexedDbName, storeName, key, data)
      }

      // Coalesce concurrent save() calls: if a persist is already
      // running, chain the next one onto it rather than racing two
      // exports against each other.
      function scheduleSave(): Promise<void> {
        savePromise = savePromise.then(persistNow, persistNow)
        return savePromise
      }

      return {
        async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
          const stmt = db.prepare(sql)
          if (params?.length) stmt.bind(params as never)

          const results: T[] = []
          while (stmt.step()) results.push(stmt.getAsObject() as T)

          stmt.free()
          return results
        },

        async execute(sql: string, params?: QueryParams): Promise<void> {
          db.run(sql, params as never)
        },

        async transaction(fn: () => Promise<void>): Promise<void> {
          const next = txQueue.then(async () => {
            // BEGIN failures (e.g. db locked) leave no transaction open,
            // so a blanket ROLLBACK in the catch would itself throw
            // "no transaction is active". Track explicitly whether we
            // actually started one before issuing ROLLBACK.
            let started = false
            saveDeferred = false
            try {
              db.run("BEGIN")
              started = true
              inTransaction = true
              await fn()
              db.run("COMMIT")
              started = false
              inTransaction = false
            } catch (error) {
              inTransaction = false
              if (started) {
                try {
                  db.run("ROLLBACK")
                } catch {
                  // Swallow: the original error is what the caller cares about.
                }
              }
              saveDeferred = false
              throw error
            }

            // One persist per committed transaction, regardless of how
            // many repos called save() inside `fn()`. Awaited so the
            // caller knows IndexedDB has the new bytes by the time
            // `transaction()` resolves.
            if (saveDeferred) {
              saveDeferred = false
              await scheduleSave()
            }
          })
          // Keep the queue alive even if this transaction throws so
          // subsequent callers don't inherit the rejection.
          txQueue = next.catch(() => undefined)
          await next
        },

        async save(): Promise<void> {
          if (inTransaction) {
            // Defer — the wrapping transaction will export once after
            // COMMIT. Calling db.export() here would close/reopen the
            // database and kill the in-flight transaction.
            saveDeferred = true
            return
          }
          await scheduleSave()
        },

        async close(): Promise<void> {
          // Flush any in-flight / queued coalesced save before tearing the
          // database down, otherwise the last write is dropped. `.catch`
          // so a failed persist still lets us close (and doesn't reject
          // close() with a stale error).
          await savePromise.catch(() => undefined)
          db.close()
        },
      }
    },
  }
}
