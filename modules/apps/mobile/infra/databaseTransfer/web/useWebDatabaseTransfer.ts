import { getBlob, saveData } from "@infra/idbKv/index.js"
import type { IDatabase, IDatabaseTransfer } from "@ports/app/index.js"

/**
 * Web adapter: persists the sql.js user database as an IndexedDB blob at
 * `{dbName}/{storeName}/{key}` (see `@infra/persistence/sqljs`). The path
 * is split once at construction. Export flushes any in-memory state
 * first; import overwrites the blob, then hard-reloads via `/welcome` so
 * the app re-bootstraps against the new data.
 */
export function useWebDatabaseTransfer(
  userDbPath: string,
  getUserDb: () => IDatabase | null
): IDatabaseTransfer {
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
      a.download = `shruti.${Date.now()}.db`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    },

    async importDatabase(file: File): Promise<void> {
      const arrayBuffer = await file.arrayBuffer()
      const data = new Uint8Array(arrayBuffer)

      await saveData(dbName, storeName, key, data)

      window.location.href = "/welcome"
    },
  }
}
