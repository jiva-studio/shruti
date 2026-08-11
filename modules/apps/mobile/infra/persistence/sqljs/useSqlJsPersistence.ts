import initSqlJs, { type Database } from "sql.js"
// Bundle the wasm locally via Vite so we don't depend on sql.js.org (which 404s).
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url"
import type { IDatabase, IPersistence } from "@ports/app/index.js"
import { saveData, getBlob } from "@kit/infra"
import { createSqlJsDatabase } from "./sqlJsDatabase.js"

export function useSqlJsPersistence(): IPersistence {
  return {
    async open(dbName: string): Promise<IDatabase> {
      const SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl,
      })

      const [indexedDbName, storeName, key] = dbName.split("/")
      const dbData = await getBlob(indexedDbName, storeName, key)
      const db: Database = dbData ? new SQL.Database(dbData) : new SQL.Database()

      // SQLite defaults `foreign_keys` OFF per connection, so the schema's
      // `ON DELETE CASCADE`s would silently no-op. Enable it to match the
      // native adapter (keeps the chat-session → messages → proactive-state
      // cascade honest on web too).
      db.run("PRAGMA foreign_keys = ON")

      return createSqlJsDatabase(db, (data) => saveData(indexedDbName, storeName, key, data))
    },
  }
}
