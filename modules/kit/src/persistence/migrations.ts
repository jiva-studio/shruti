import type { IDatabase } from "./database.js"

/**
 * A single forward-only migration. `name` is the stable identifier tracked in
 * the `migrations` table; `up` applies the change.
 */
export interface Migration {
  name: string
  up: (db: IDatabase) => Promise<void>
}

/**
 * Apply pending migrations in order, recording applied ones in a `migrations`
 * table. Idempotent — safe to call on every startup; already-applied
 * migrations are skipped by name.
 *
 * Generic engine: each app declares its own schema as an ordered
 * `Migration[]` and passes it in. The **first** migration must create the
 * `migrations` table (`CREATE TABLE IF NOT EXISTS migrations (name, applied_at)`)
 * — it runs unconditionally before the applied-set is read.
 */
export async function runMigrations(
  db: IDatabase,
  migrations: readonly Migration[]
): Promise<void> {
  if (migrations.length === 0) return

  // First migration creates the migrations table — run unconditionally.
  await migrations[0].up(db)

  const applied = await db.query<{ name: string }>("SELECT name FROM migrations")
  const appliedNames = new Set(applied.map((r) => r.name))

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue
    // Apply the migration and record it atomically: on native each execute
    // autocommits, so without a transaction a process kill (or a failing
    // INSERT) between the two would leave the change durable but unrecorded,
    // replaying the non-idempotent migration on every later launch.
    await db.transaction(async () => {
      await migration.up(db)
      await db.execute("INSERT INTO migrations (name, applied_at) VALUES (?, ?)", [
        migration.name,
        new Date().toISOString(),
      ])
    })
  }

  await db.save()
}
