import { Filesystem, Directory } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"
import type { IDatabase, IDatabaseTransfer } from "@ports/app/index.js"

/**
 * Native adapter: exports the user database via SQLite's `VACUUM INTO` to
 * a cache-dir copy and hands it to `@capacitor/share` so the user can save
 * or send the file via the OS share-sheet. Imports close the live
 * connection, swap the SQLite file on disk, and hard-reload so bootstrap
 * re-opens the imported file and `runUserMigrations` brings any older
 * schema up to the current app version.
 */
export function useCapacitorDatabaseTransfer(
  userDbPath: string,
  getUserDb: () => IDatabase | null
): IDatabaseTransfer {
  function requireDb(): IDatabase {
    const db = getUserDb()
    if (!db) throw new Error("User database is not open")
    return db
  }

  async function safeDelete(path: string): Promise<void> {
    try {
      await Filesystem.deleteFile({ path, directory: Directory.Data })
    } catch {
      // Sidecar/main file may not exist (fresh install, WAL disabled, …).
    }
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

      // SQLite files start with the 16-byte magic header "SQLite format 3\0".
      // Reject early so a garbage file (e.g. wrong attachment) can't nuke
      // the live user.db at the file-swap step below.
      const header = "SQLite format 3\0"
      if (bytes.length < header.length) {
        throw new Error("Selected file is too small to be a SQLite database")
      }
      for (let i = 0; i < header.length; i++) {
        if (bytes[i] !== header.charCodeAt(i)) {
          throw new Error("Selected file is not a SQLite database")
        }
      }

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

      // Release the live connection so the SQLite file lock drops before
      // we replace the file on disk. `IDatabase.close()` closes the
      // underlying NC connection (see useCapacitorSqlPersistence).
      const liveDb = getUserDb()
      if (liveDb) await liveDb.close()

      // Drop any sidecars left over from the previous DB; a stale `-wal`
      // / `-journal` paired with a fresh `user.db` would confuse SQLite
      // on the next open.
      await safeDelete(userDbPath)
      await safeDelete(`${userDbPath}-journal`)
      await safeDelete(`${userDbPath}-wal`)
      await safeDelete(`${userDbPath}-shm`)

      // Copy the imported file into place. `Directory.Data` is the same
      // root the persistence layer uses for `Filesystem.mkdir`, and the
      // SQLite plugin resolves NC paths under the same root, so the
      // bootstrap on reload will open this exact file.
      await Filesystem.copy({
        from: importName,
        directory: Directory.Cache,
        to: userDbPath,
        toDirectory: Directory.Data,
      })

      // Best-effort cleanup of the cache staging file.
      try {
        await Filesystem.deleteFile({ path: importName, directory: Directory.Cache })
      } catch {
        // Cache eviction is acceptable; we'll let the OS reclaim it.
      }

      // Hard reload: bootstrap re-opens the freshly-written user.db and
      // `runUserMigrations` applies whatever migrations the imported DB
      // is missing (e.g. 006_notes_meta, 007_chat_messages for a backup
      // taken before 2026-05-16).
      window.location.href = "/welcome"
    },
  }
}
