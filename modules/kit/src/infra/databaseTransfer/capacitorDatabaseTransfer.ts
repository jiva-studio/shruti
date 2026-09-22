import { Filesystem, Directory } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"
import { isSqliteFile, replaceDatabaseContents, type IDatabase } from "../../persistence/index.js"
import type { IDatabaseTransfer } from "./databaseTransfer.js"

/**
 * Configuration for the native database transfer adapter. All app-facing
 * strings (export filename, share-sheet title, post-import navigation)
 * are injected so the adapter carries no app identity.
 */
export interface CapacitorDatabaseTransferOptions {
  /** Open user database, or `null` when not yet opened. */
  getUserDb: () => IDatabase | null
  /**
   * Builds the export filename, e.g. `() => \`backup.${Date.now()}.db\``.
   * Called once per export.
   */
  exportFileName: () => string
  /** Title shown in the native share sheet. */
  shareTitle: string
  /**
   * Called after a successful import to re-bootstrap the app against the
   * new data (typically a hard navigation, e.g.
   * `() => { window.location.href = "/welcome" }`). The user DB will be
   * re-opened and migrations re-run on the next bootstrap.
   */
  onImported: () => void
}

/**
 * Native {@link IDatabaseTransfer}.
 *
 * Export: `VACUUM INTO` a cache-dir copy and hand it to `@capacitor/share`.
 *
 * Import: replace the live DB's contents with the imported file's
 * contents in a single SQL transaction (via the generic
 * `replaceDatabaseContents` core), then trigger `onImported` so the
 * caller re-bootstraps and migrations bring any older imported schema
 * forward to current.
 *
 * The SQL-layer replace (rather than a literal file swap) is used
 * because the SQLite plugin stores the user DB in a sandboxed location
 * unreachable by `@capacitor/filesystem`'s `Directory.*` enums. So we
 * ATTACH the imported file, drop everything in `main`, re-create every
 * schema object from `imported.sqlite_master`, and copy data 1:1. The
 * `migrations` table comes along, so the next bootstrap's migration run
 * reads the imported migration history and applies anything missing.
 */
export function useCapacitorDatabaseTransfer(
  options: CapacitorDatabaseTransferOptions
): IDatabaseTransfer {
  const { getUserDb, exportFileName, shareTitle, onImported } = options

  function requireDb(): IDatabase {
    const db = getUserDb()
    if (!db) throw new Error("User database is not open")
    return db
  }

  return {
    async exportDatabase(): Promise<void> {
      const db = requireDb()

      const cacheUri = await Filesystem.getUri({
        path: exportFileName(),
        directory: Directory.Cache,
      })

      // VACUUM INTO makes a clean copy without closing the live DB.
      await db.execute(`VACUUM INTO '${cacheUri.uri.replace("file://", "")}'`)

      await Share.share({
        title: shareTitle,
        url: cacheUri.uri,
      })
    },

    async importDatabase(file: File): Promise<void> {
      const arrayBuffer = await file.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)

      // Reject early so a garbage file (wrong attachment, half-downloaded
      // archive, …) can't be ATTACHed and end up silently destroying the
      // live DB inside the replace transaction.
      if (!isSqliteFile(bytes)) {
        throw new Error("Selected file is not a SQLite database")
      }

      // Stage to the cache dir as base64 — Filesystem.writeFile is
      // text-oriented; SQLite is fed the resolved absolute path via
      // ATTACH below.
      let binary = ""
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const base64 = btoa(binary)

      const importName = `import.${Date.now()}.db`
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

      // ATTACH must run outside a transaction; the SQL-layer rebuild lives
      // in the generic kit helper, which also toggles foreign-key
      // enforcement.
      await db.execute(`ATTACH DATABASE '${importPath}' AS imported`)
      try {
        await replaceDatabaseContents(db, "imported")
      } finally {
        await db.execute("DETACH DATABASE imported")
      }
      await db.save()

      // Best-effort cleanup of the cache staging file.
      try {
        await Filesystem.deleteFile({ path: importName, directory: Directory.Cache })
      } catch {
        // Cache eviction is acceptable; OS will reclaim it.
      }

      onImported()
    },
  }
}
