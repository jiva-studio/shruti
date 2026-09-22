import { getBlob, saveData } from "../idbKv.js"
import { isSqliteFile, type IDatabase } from "../../persistence/index.js"
import type { IDatabaseTransfer } from "./databaseTransfer.js"

/**
 * Configuration for the web database transfer adapter.
 */
export interface WebDatabaseTransferOptions {
  /**
   * IndexedDB location of the user database blob, as
   * `"<dbName>/<storeName>/<key>"` (the same path the web SQL
   * persistence adapter writes to).
   */
  userDbPath: string
  /** Open user database, or `null` when not yet opened. */
  getUserDb: () => IDatabase | null
  /** Builds the download filename, e.g. `() => \`backup.${Date.now()}.db\``. */
  exportFileName: () => string
  /** Called after a successful import so the caller re-bootstraps. */
  onImported: () => void
}

/**
 * Web {@link IDatabaseTransfer}: persists the sql.js user database as an
 * IndexedDB blob at `{dbName}/{storeName}/{key}`. The path is split once
 * at construction. Export flushes any in-memory state first then offers a
 * Blob download; import overwrites the blob then triggers `onImported`.
 */
export function useWebDatabaseTransfer(options: WebDatabaseTransferOptions): IDatabaseTransfer {
  const { userDbPath, getUserDb, exportFileName, onImported } = options
  const [dbName, storeName, key] = userDbPath.split("/")

  return {
    async exportDatabase(): Promise<void> {
      // Flush in-memory sql.js state to IndexedDB before reading.
      const db = getUserDb()
      if (db) await db.save()

      const data = await getBlob(dbName, storeName, key)
      if (!data) {
        throw new Error("No user database found to export")
      }

      const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = exportFileName()
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    },

    async importDatabase(file: File): Promise<void> {
      const arrayBuffer = await file.arrayBuffer()
      const data = new Uint8Array(arrayBuffer)

      // Reject early so a garbage file (wrong attachment, half-downloaded
      // archive, …) can't silently overwrite the user DB and brick bootstrap.
      if (!isSqliteFile(data)) {
        throw new Error("Selected file is not a SQLite database")
      }

      await saveData(dbName, storeName, key, data)

      onImported()
    },
  }
}
