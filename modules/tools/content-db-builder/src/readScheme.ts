import BetterSqlite3 from "better-sqlite3"

export function readSchemeFromDb(dbPath: string): number {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    const row = db
      .prepare(
        "SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1"
      )
      .get() as { scheme: number } | undefined
    return row?.scheme ?? 0
  } finally {
    db.close()
  }
}
