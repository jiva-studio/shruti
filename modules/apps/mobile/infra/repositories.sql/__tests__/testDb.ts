import initSqlJs, { type Database as SqlJsDb } from "sql.js"
import type { IDatabase, QueryParams } from "@ports/app/index.js"

/**
 * Creates an in-memory sql.js IDatabase for use in repository tests.
 * `save()` is a no-op so tests don't need IndexedDB support in Node.
 */
export async function createInMemoryTestDatabase(): Promise<IDatabase> {
  const SQL = await initSqlJs()
  const db: SqlJsDb = new SQL.Database()

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
      /* no-op for tests */
    },

    async close(): Promise<void> {
      db.close()
    },
  }
}
