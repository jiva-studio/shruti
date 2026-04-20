import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite"
import { Capacitor } from "@capacitor/core"
import { Filesystem, Directory } from "@capacitor/filesystem"
import type { IDatabase, IPersistence, QueryParams } from "@ports/app/index.js"

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

      const lastSlash = dbPath.lastIndexOf("/")
      const hasPath = lastSlash > 0
      const directory = hasPath ? dbPath.substring(0, lastSlash) : ""
      const database = hasPath ? dbPath.substring(lastSlash + 1) : dbPath
      const dbName = database.replace(".db", "")

      let db: SQLiteDBConnection
      let fullPath = ""

      if (hasPath) {
        await ensureDirectoryExists(directory)

        const platform = Capacitor.getPlatform()
        const ncDirectory =
          platform === "android"
            ? `files/${directory}`
            : platform === "ios"
              ? `Documents/${directory}`
              : directory
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

      return {
        async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
          const result = await db.query(sql, params as unknown[])
          return (result.values ?? []) as T[]
        },

        async execute(sql: string, params?: QueryParams): Promise<void> {
          await db.run(sql, params as unknown[], false)
        },

        async transaction(fn: () => Promise<void>): Promise<void> {
          await db.beginTransaction()
          try {
            await fn()
            await db.commitTransaction()
          } catch (error) {
            await db.rollbackTransaction()
            throw error
          }
        },

        async save(): Promise<void> {},

        async close(): Promise<void> {
          await db.close()
          if (hasPath) {
            await sqlite.closeNCConnection(fullPath)
          } else {
            await sqlite.closeConnection(dbName, false)
          }
        },
      }
    },
  }
}
