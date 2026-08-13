import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { UserDatabase } from "../../ports/UserDatabase.js"
import type { Adb } from "./Adb.js"

// `@capacitor-community/sqlite` appends "SQLite.db" to the connection name and
// keeps the file where Android keeps databases, so the app's `user` database
// lives at `databases/userSQLite.db` under its data dir.
const DIR = "databases"
const FILE = "userSQLite.db"
// A write-ahead log holds commits the main file does not have yet, so both
// sidecars travel with the database in each direction.
const PARTS = ["", "-wal", "-shm"]

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export class AndroidUserDatabase implements UserDatabase {
  constructor(private readonly adb: Adb) {}

  private get pkg(): string {
    return this.adb.appPackage
  }

  async install(localFile: string): Promise<void> {
    this.assertReachable()
    const staged = `/data/local/tmp/${FILE}`
    this.adb.exec("push", localFile, staged)
    this.adb.shell(`run-as ${this.pkg} mkdir -p ${DIR}`)
    // `run-as` cannot read /data/local/tmp, so the shell user does the reading
    // and the app user only receives the bytes on stdin.
    this.adb.shell(`cat ${staged} | run-as ${this.pkg} sh -c 'cat > ${DIR}/${FILE}'`)
    // A journal left by the database being replaced would be replayed over the
    // fixture — with a header that no longer matches it.
    this.adb.shell(`run-as ${this.pkg} rm -f ${DIR}/${FILE}-wal ${DIR}/${FILE}-shm`)
    this.adb.shell(`rm -f ${staged}`)
  }

  async appliedMigrations(): Promise<string[]> {
    return this.read((db) => this.names(db, "SELECT name FROM migrations ORDER BY name"))
  }

  async tables(): Promise<string[]> {
    return this.read((db) =>
      this.names(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    )
  }

  async columnsOf(table: string): Promise<string[]> {
    assertIdentifier(table)
    return this.read((db) => this.names(db, `PRAGMA table_info(${table})`).sort())
  }

  async indexes(): Promise<string[]> {
    return this.read((db) =>
      this.names(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    )
  }

  async rows(table: string, columns: readonly string[]): Promise<Record<string, unknown>[]> {
    assertIdentifier(table)
    for (const column of columns) assertIdentifier(column)
    return this.read((db) =>
      db
        .prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`)
        .all()
        .map((row) => ({ ...row })),
    )
  }

  private names(db: DatabaseSync, sql: string): string[] {
    return db
      .prepare(sql)
      .all()
      .map((row) => String(row.name))
  }

  /** Every read works on a copy: the file belongs to the app, and SQLite may
   *  have to replay its log to see the last commits. */
  private read<T>(query: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.pull())
    try {
      return query(db)
    } finally {
      db.close()
    }
  }

  private pull(): string {
    this.assertReachable()
    const dir = mkdtempSync(join(tmpdir(), "lectorium-user-db-"))
    for (const part of PARTS) {
      const remote = `${DIR}/${FILE}${part}`
      const staged = `/data/local/tmp/pulled-${FILE}${part}`
      // The app user reads its own file; the shell user owns the redirect.
      this.adb.shell(
        `rm -f ${staged}; run-as ${this.pkg} cat ${remote} > ${staged} 2>/dev/null || true`,
      )
      const local = join(dir, `${FILE}${part}`)
      this.adb.exec("pull", staged, local)
      // The redirect creates the staged file even when the sidecar does not
      // exist; an empty one next to a real log would only confuse SQLite.
      if (statSync(local).size === 0) rmSync(local)
      this.adb.shell(`rm -f ${staged}`)
    }
    return join(dir, FILE)
  }

  /** `run-as` is the only door into a debuggable app's data dir; a release APK
   *  would need `adb root`. Say which one is missing instead of letting a spec
   *  assert against an empty database. */
  private assertReachable(): void {
    let out = ""
    try {
      out = this.adb.shell(`run-as ${this.pkg} echo ok`)
    } catch (error) {
      out = String(error)
    }
    if (out.includes("ok")) return
    throw new Error(`run-as ${this.pkg} refused — is the debug APK installed? (${out.trim()})`)
  }
}

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`not a table or column name: "${name}"`)
}
