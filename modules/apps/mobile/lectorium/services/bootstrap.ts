import type { IDatabase, IPreferences } from "@ports/app/index.js"
import { runUserMigrations } from "@lectorium/services/migrations/user/runMigrations.js"
import type { useLectorium } from "@lectorium/lectorium.js"

export interface BootstrapUserDatabaseDeps {
  readonly userDbPath: string
  readonly openUserDatabase: (path: string) => Promise<IDatabase>
  readonly userDatabase: () => IDatabase | undefined
  /** Optional — when provided, ensure `chat.clientId` is seeded after
   *  migrations. Skipping the field keeps the helper usable from tests. */
  readonly preferences?: IPreferences
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

  if (deps.preferences) {
    await ensureChatClientId(deps.preferences)
  }
}

/**
 * Chat backend tracks per-device usage by a stable UUID we ship as
 * `X-Device-Id`. Generated lazily on first bootstrap after migrations
 * and persisted via `IPreferences` so it survives reinstalls of the
 * user DB (e.g. import flow). Idempotent.
 */
export async function ensureChatClientId(preferences: IPreferences): Promise<string> {
  const existing = await preferences.get("chat.clientId")
  if (existing) return existing
  const fresh =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : fallbackUuid()
  await preferences.set("chat.clientId", fresh)
  return fresh
}

function fallbackUuid(): string {
  // RFC4122 v4-ish; only used in environments without crypto.randomUUID
  // (older Capacitor WebViews would crash on the call site). Good enough
  // for an opaque device id — never used as a security primitive.
  const hex = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-"
    } else if (i === 14) {
      out += "4"
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)]
    } else {
      out += hex[Math.floor(Math.random() * 16)]
    }
  }
  return out
}

/**
 * Convenience overload that takes the composition root directly. Use
 * from `WelcomeView.controller`; tests should call the explicit-deps
 * form above.
 */
export function bootstrapUserDatabaseFromApp(app: ReturnType<typeof useLectorium>): Promise<void> {
  return bootstrapUserDatabase({
    userDbPath: app.appConfig.database.userLocalPath,
    openUserDatabase: (path) => app.openUserDatabase(path),
    userDatabase: (): IDatabase | undefined => app.databases.user ?? undefined,
    preferences: app.preferences,
  })
}
