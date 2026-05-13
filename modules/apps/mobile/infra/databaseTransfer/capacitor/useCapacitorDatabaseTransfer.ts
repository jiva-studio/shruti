import { Filesystem, Directory } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"
import type { IDatabase, IDatabaseTransfer } from "@ports/app/index.js"

/**
 * Native adapter: exports the user database via SQLite's `VACUUM INTO` to
 * a cache-dir copy and hands it to `@capacitor/share` so the user can save
 * or send the file via the OS share-sheet. Imports take an attached
 * foreign database, disable FKs, and bulk-replace every user table in a
 * single transaction.
 */
export function useCapacitorDatabaseTransfer(getUserDb: () => IDatabase | null): IDatabaseTransfer {
  function requireDb(): IDatabase {
    const db = getUserDb()
    if (!db) throw new Error("User database is not open")
    return db
  }

  return {
    async exportDatabase(): Promise<void> {
      const db = requireDb()

      const exportName = `shruti.${Date.now()}.db`
      const cacheUri = await Filesystem.getUri({
        path: exportName,
        directory: Directory.Cache,
      })

      // VACUUM INTO makes a clean copy without closing the live DB.
      await db.execute(`VACUUM INTO '${cacheUri.uri.replace("file://", "")}'`)

      await Share.share({
        title: "Shruti Database",
        url: cacheUri.uri,
      })
    },

    async importDatabase(file: File): Promise<void> {
      const arrayBuffer = await file.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)

      // Convert to base64 for Filesystem.writeFile (Capacitor's text-oriented API).
      let binary = ""
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const base64 = btoa(binary)

      const importName = `shruti.import.${Date.now()}.db`
      await Filesystem.writeFile({
        path: importName,
        directory: Directory.Cache,
        data: base64,
      })

      const cacheUri = await Filesystem.getUri({
        path: importName,
        directory: Directory.Cache,
      })
      const importPath = cacheUri.uri.replace("file://", "")

      const db = requireDb()

      // Pull the user-table list dynamically — the `migrations` table is
      // skipped so an import doesn't lock the receiving app into the
      // source's schema version (the receiver's own migrations have
      // already run before this point).
      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name != 'migrations' AND name NOT LIKE 'sqlite_%'"
      )

      // ATTACH and PRAGMA must run outside a transaction.
      // FKs are disabled during bulk replace because table-by-table DELETE
      // order would otherwise break referential integrity.
      await db.execute(`ATTACH DATABASE '${importPath}' AS imported`)
      try {
        await db.execute("PRAGMA foreign_keys = OFF")
        await db.transaction(async () => {
          for (const { name } of tables) {
            await db.execute(`DELETE FROM main.${name}`)
            await db.execute(`INSERT INTO main.${name} SELECT * FROM imported.${name}`)
          }
        })
        await db.execute("PRAGMA foreign_keys = ON")
      } finally {
        await db.execute("DETACH DATABASE imported")
      }
      await db.save()

      window.location.href = "/welcome"
    },
  }
}
