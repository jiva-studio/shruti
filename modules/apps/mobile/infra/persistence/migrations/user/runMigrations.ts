import type { IDatabase } from "@ports/app/index.js"
import { userMigrations } from "./index.js"

/**
 * Applies pending user-DB migrations in order, tracking what's already
 * applied in the `migrations` table. Safe to call on every startup:
 * already-applied migrations are skipped by name.
 */
export async function runUserMigrations(db: IDatabase): Promise<void> {
  // First migration creates the migrations table — run unconditionally.
  await userMigrations[0].up(db)

  const applied = await db.query<{ name: string }>("SELECT name FROM migrations")
  const appliedNames = new Set(applied.map((r) => r.name))

  for (const migration of userMigrations) {
    if (appliedNames.has(migration.name)) continue
    await migration.up(db)
    await db.execute("INSERT INTO migrations (name, applied_at) VALUES (?, ?)", [
      migration.name,
      new Date().toISOString(),
    ])
  }

  await db.save()
}
