import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** What `makeUserDb.ts` recorded: the chain the fixture stopped at, and the
 *  database a full run of the chain produced on this machine's SQLite. */
export interface OldUserDatabase {
  readonly databasePath: string
  readonly appliedInFixture: readonly string[]
  readonly pending: readonly string[]
  readonly expected: {
    readonly migrations: readonly string[]
    readonly tables: Readonly<Record<string, readonly string[]>>
    readonly indexes: readonly string[]
    readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>>
    readonly configEntries: readonly { readonly key: string; readonly value: string }[]
  }
}

export function oldUserDatabase(): OldUserDatabase {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("user-old.json", import.meta.url)), "utf8"),
  ) as Omit<OldUserDatabase, "databasePath"> & { database: string }
  return {
    ...manifest,
    databasePath: fileURLToPath(new URL(manifest.database, import.meta.url)),
  }
}
