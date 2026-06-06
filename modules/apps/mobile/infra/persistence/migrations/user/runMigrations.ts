import { runMigrations } from "@kit/persistence"
import type { IDatabase } from "@ports/app/index.js"
import { userMigrations } from "./index.js"

/**
 * Applies pending user-DB migrations using the generic engine from
 * `@kit/persistence`. The app owns the ordered `userMigrations` list; the
 * runner (apply-pending, skip-applied, record in `migrations`) is shared.
 */
export async function runUserMigrations(db: IDatabase): Promise<void> {
  await runMigrations(db, userMigrations)
}
