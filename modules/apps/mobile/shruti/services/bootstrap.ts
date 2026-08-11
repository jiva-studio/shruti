import type { IDatabase } from "@ports/app/index.js"
import { runUserMigrations } from "@infra/persistence/migrations/user/runMigrations.js"
import type { useShruti } from "@shruti/shruti.js"

export interface BootstrapUserDatabaseDeps {
  readonly userDbPath: string
  readonly openUserDatabase: (path: string) => Promise<IDatabase>
  readonly userDatabase: () => IDatabase | undefined
}

/**
 * Open the user database at the configured path and apply pending
 * migrations. Bootstrapping step that runs after the content database
 * has been resolved + validated.
 *
 * Kept as a small service rather than living inside the WelcomeView
 * controller so the same flow can be exercised from a future
 * "import user data" path or from tests without spinning up Ionic.
 *
 * Throws on any underlying failure — the caller decides whether to
 * surface a retry / error UI.
 */
export async function bootstrapUserDatabase(deps: BootstrapUserDatabaseDeps): Promise<void> {
  await deps.openUserDatabase(deps.userDbPath)
  const db = deps.userDatabase()
  if (!db) {
    // openUserDatabase resolved without populating the runtime handle —
    // a programmer error in the composition root, not a recoverable one.
    throw new Error("openUserDatabase resolved without exposing the user database handle")
  }
  await runUserMigrations(db)
}

/**
 * Convenience overload that takes the composition root directly. Use
 * from `WelcomeView.controller`; tests should call the explicit-deps
 * form above.
 */
export function bootstrapUserDatabaseFromApp(app: ReturnType<typeof useShruti>): Promise<void> {
  return bootstrapUserDatabase({
    userDbPath: app.appConfig.database.userLocalPath,
    openUserDatabase: (path) => app.openUserDatabase(path),
    userDatabase: (): IDatabase | undefined => app.databases.user ?? undefined,
  })
}

/**
 * The same bootstrap, leaving NO handle behind when it fails.
 *
 * Opening and being usable are not the same thing. sql.js accepts a file whose
 * header is not SQLite's and only fails when a statement reaches the schema —
 * so `openUserDatabase` resolves, `databases.user` is set, and the app carries
 * on with a database every write will fail against. A half-applied migration is
 * the same story with a smaller blast radius.
 *
 * Dropping the handle turns that into a state the app can see: `repositories()`
 * refuses, the router sends the user to `/storage-error`, and the failure gets
 * said out loud instead of turning into notes that quietly never save.
 */
export async function bootstrapUserDatabaseOrClose(
  app: ReturnType<typeof useShruti>
): Promise<void> {
  try {
    await bootstrapUserDatabaseFromApp(app)
  } catch (err) {
    await app.closeUserDatabase().catch(() => undefined)
    throw err
  }
}
