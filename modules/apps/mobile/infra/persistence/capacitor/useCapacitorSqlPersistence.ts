import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite"
import { Capacitor } from "@capacitor/core"
import { Filesystem, Directory } from "@capacitor/filesystem"
import type { IDatabase, IPersistence } from "@ports/app/index.js"
import { applyConnectionPragmas, createCapacitorDatabase } from "./capacitorDatabase.js"

async function ensureDirectoryExists(directory: string): Promise<void> {
  if (!directory) return
  try {
    await Filesystem.mkdir({
      path: directory,
      directory: Directory.Data,
      recursive: true,
    })
  } catch {
    // Directory already exists, ignore
  }
}

/**
 * How a configured database path maps onto the plugin's two storage models.
 *
 * A path with a directory is a "non-conformed" (NC) database — a plain file at
 * that path under `Directory.Data`, which is where the content catalogs live
 * and what the bundled-asset copy writes. A bare name is a regular connection,
 * which the plugin keeps in its own sandbox (`getDatabasePath()/<name>SQLite.db`
 * on Android) under a `SQLite.db` suffix, out of reach of `@capacitor/filesystem`.
 */
function splitDbPath(dbPath: string): {
  hasPath: boolean
  directory: string
  database: string
  dbName: string
} {
  const lastSlash = dbPath.lastIndexOf("/")
  const hasPath = lastSlash > 0
  const directory = hasPath ? dbPath.substring(0, lastSlash) : ""
  const database = hasPath ? dbPath.substring(lastSlash + 1) : dbPath
  return { hasPath, directory, database, dbName: database.replace(".db", "") }
}

/** Directory the plugin's NC path resolution expects, per platform. */
function ncDirectoryFor(directory: string): string {
  const platform = Capacitor.getPlatform()
  if (platform === "android") return `files/${directory}`
  if (platform === "ios") return `Documents/${directory}`
  return directory
}

export function useCapacitorSqlPersistence(): IPersistence {
  const sqlite = new SQLiteConnection(CapacitorSQLite)

  /**
   * Reconciles JS ↔ native connection state once per plugin instance.
   *
   * A Capacitor webview reload (e.g. `window.location.href = "/welcome"`
   * triggered by the Settings "reload database" action) wipes the JS
   * side of `@capacitor-community/sqlite`'s connection registry but
   * leaves the native side intact, because the app process is not
   * restarted. The next `createConnection` / `createNCConnection` for
   * the same path then fails with "Connection … already exists".
   *
   * `SQLiteConnection.checkConnectionsConsistency()` is the plugin's
   * recommended fix for this scenario: it diffs the JS-side connection
   * dict (empty, right after construction) against the native `dbDict`
   * and closes any native entry that's not present on the JS side. With
   * an empty JS dict this effectively calls `closeAllConnections()` on
   * the native side, covering both regular and NC connections (they
   * share the same native map).
   *
   * It's a best-effort one-shot: we run it lazily on first `open()` and
   * cache the promise so subsequent opens for other databases wait for
   * the same reconciliation. Errors are swallowed — if the plugin fails
   * the check (e.g. nothing to reconcile), we still want `open()` to
   * proceed and let the per-connection stale-release path below act as
   * a second layer of defence.
   */
  let consistencyPromise: Promise<void> | null = null
  function ensureNativeConnectionsConsistent(): Promise<void> {
    if (!consistencyPromise) {
      consistencyPromise = sqlite.checkConnectionsConsistency().then(
        () => undefined,
        () => undefined
      )
    }
    return consistencyPromise
  }

  /**
   * Belt-and-braces second layer for the reload scenario: even after
   * `checkConnectionsConsistency`, probe the JS-side registry for a
   * stale entry for this specific path and close it before creating a
   * new one. This catches the non-reload case where the JS registry
   * *does* still know about the connection (e.g. a previous open()
   * that wasn't followed by a close()).
   */
  async function releaseStaleNCConnection(fullPath: string): Promise<void> {
    try {
      const { result } = await sqlite.isNCConnection(fullPath)
      if (result === true) {
        await sqlite.closeNCConnection(fullPath)
      }
    } catch {
      // Best-effort: if the plugin can't tell us or can't close a stale
      // connection, fall through and let createNCConnection surface the
      // original error.
    }
  }

  async function releaseStaleConnection(dbName: string): Promise<void> {
    try {
      const { result } = await sqlite.isConnection(dbName, false)
      if (result === true) {
        await sqlite.closeConnection(dbName, false)
      }
    } catch {
      // Same rationale as releaseStaleNCConnection.
    }
  }

  return {
    async open(dbPath: string): Promise<IDatabase> {
      // Reconcile any native connections left over from a previous
      // webview session (reload, hot reload, crash-recover) before we
      // try to create a new one. Guaranteed to run exactly once per
      // plugin instance across concurrent open() calls.
      await ensureNativeConnectionsConsistent()

      const { hasPath, directory, database, dbName } = splitDbPath(dbPath)

      let db: SQLiteDBConnection
      let fullPath = ""

      if (hasPath) {
        await ensureDirectoryExists(directory)

        const ncDirectory = ncDirectoryFor(directory)
        const result = await sqlite.getNCDatabasePath(ncDirectory, database)
        if (!result.path) {
          throw new Error(`Failed to get NC database path for ${ncDirectory}/${database}`)
        }
        fullPath = result.path
        await releaseStaleNCConnection(fullPath)
        db = await sqlite.createNCConnection(fullPath, 1)
      } else {
        await releaseStaleConnection(dbName)
        db = await sqlite.createConnection(dbName, false, "no-encryption", 1, false)
      }

      await db.open()
      await applyConnectionPragmas(db)

      return createCapacitorDatabase(db, async () => {
        if (hasPath) await sqlite.closeNCConnection(fullPath)
        else await sqlite.closeConnection(dbName, false)
      })
    },

    async deleteDatabase(dbPath: string): Promise<void> {
      await ensureNativeConnectionsConsistent()

      const { hasPath, directory, database, dbName } = splitDbPath(dbPath)

      if (hasPath) {
        // NC databases are ordinary files under Directory.Data, so the
        // filesystem can remove them without the plugin's help.
        const { path } = await sqlite.getNCDatabasePath(ncDirectoryFor(directory), database)
        if (path) await releaseStaleNCConnection(path)
        try {
          await Filesystem.deleteFile({ path: dbPath, directory: Directory.Data })
        } catch {
          // Nothing there — the caller wanted it gone, and it is.
        }
        return
      }

      // A regular connection's file lives in the plugin's own sandbox
      // (`<name>SQLite.db` under getDatabasePath() on Android), which
      // `@capacitor/filesystem`'s Directory.* enums cannot address — so the
      // delete has to go through the plugin, and the plugin only deletes a
      // database it holds a connection for. `createConnection` registers one
      // without opening the file, which is what makes this work for a database
      // that is corrupt or mid-failed-migration (#1831).
      await releaseStaleConnection(dbName)
      const db = await sqlite.createConnection(dbName, false, "no-encryption", 1, false)
      try {
        await db.delete()
      } finally {
        await releaseStaleConnection(dbName)
      }
    },
  }
}
