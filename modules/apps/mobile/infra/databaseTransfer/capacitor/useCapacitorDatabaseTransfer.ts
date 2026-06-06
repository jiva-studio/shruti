import { Filesystem, Directory } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"
import { isSqliteFile, replaceDatabaseContents } from "@kit/persistence"
import type { IDatabase, IDatabaseTransfer } from "@ports/app/index.js"

/**
 * Native adapter for the user database transfer port.
 *
 * Export: `VACUUM INTO` a cache-dir copy and hand it to `@capacitor/share`.
 *
 * Import: replace the live DB's contents with the imported file's
 * contents in a single SQL transaction, then hard-reload so
 * `runUserMigrations` brings any older schema forward to current.
 *
 * Why SQL replace instead of a literal file swap: the
 * `@capacitor-community/sqlite` plugin stores the user DB under
 * `context.getDatabasePath("userSQLite.db")` (Android) /
 * `Documents/userSQLite.db` (iOS) — a sandboxed location that no
 * `Directory.*` enum in `@capacitor/filesystem` v8 can reach (see
 * `LegacyFilesystemImplementation.kt:54`). The plugin's NC mode
 * (path-based connections) is read-only on both platforms
 * (`CapacitorSQLite.java:391`, `CapacitorSQLite.swift:315`), and
 * `getFromHTTPRequest` works on Android with `file://` URLs but not
 * on iOS (`URLSession.downloadTask` rejects `file://`). So we do the
 * swap at the SQL layer: ATTACH the imported file, drop everything
 * in `main`, re-create every schema object from `imported.sqlite_master`
 * (verbatim CREATE statements), and copy data 1:1. The
 * `migrations` table comes along, so after reload
 * `runUserMigrations` reads the imported migration history and
 * applies the missing versions (e.g. 006_notes_meta,
 * 007_chat_messages, 008_chat_message_actions for a pre-2026-05-16
 * backup) on top. End-state is bit-identical to file-swap +
 * migrate.
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

      const exportName = `lectorium.${Date.now()}.db`
      const cacheUri = await Filesystem.getUri({
        path: exportName,
        directory: Directory.Cache,
      })

      // VACUUM INTO makes a clean copy without closing the live DB.
      await db.execute(`VACUUM INTO '${cacheUri.uri.replace("file://", "")}'`)

      await Share.share({
        title: "Lectorium Database",
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
      // text-oriented; we'll feed SQLite the resolved absolute path
      // via ATTACH below.
      let binary = ""
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const base64 = btoa(binary)

      const importName = `lectorium.import.${Date.now()}.db`
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

      // ATTACH must run outside a transaction; the SQL-layer rebuild (drop
      // main, re-create from imported.sqlite_master, copy rows) lives in the
      // generic kit helper, which also toggles foreign-key enforcement.
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

      // Hard reload: bootstrap re-opens the user DB and calls
      // `runUserMigrations`, which reads the imported `migrations`
      // table and applies anything missing (e.g. 006/007/008 on a
      // pre-2026-05-16 backup) on top.
      window.location.href = "/welcome"
    },
  }
}
