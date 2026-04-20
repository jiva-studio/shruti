import initSqlJs, { type Database } from "sql.js"
// Bundle the wasm locally via Vite so we don't depend on sql.js.org (which 404s).
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url"
import type { IDatabase, IPersistence, QueryParams } from "@ports/app/index.js"
import { saveData, getBlob } from "@infra/idbKv/index.js"

export function useSqlJsPersistence(): IPersistence {
  return {
    async open(dbName: string): Promise<IDatabase> {
      const SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl,
      })

      const [indexedDbName, storeName, key] = dbName.split("/")
      const dbData = await getBlob(indexedDbName, storeName, key)
      const db: Database = dbData ? new SQL.Database(dbData) : new SQL.Database()

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
          try {
            db.run("BEGIN")
            await fn()
            db.run("COMMIT")
          } catch (error) {
            db.run("ROLLBACK")
            throw error
          }
        },

        async save(): Promise<void> {
          await saveData(indexedDbName, storeName, key, db.export())
        },

        async close(): Promise<void> {
          db.close()
        },
      }
    },
  }
}
