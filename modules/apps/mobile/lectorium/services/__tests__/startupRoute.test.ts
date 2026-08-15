import { afterEach, describe, expect, it, vi } from "vitest"

import type { CdnServer } from "@lib/domain/servers.js"
import type { IDatabase, IPreferences } from "@ports/app/index.js"
import {
  initLectorium,
  __resetLectoriumForTests,
  type InitLectoriumSeed,
  type Lectorium,
} from "@lectorium/lectorium.js"
import { STORAGE_ERROR_PATH } from "@lectorium/router/databaseGuard.js"
import { resolveInitialRoute } from "../startupRoute.js"
import { resetLocalUserDatabaseFromApp } from "../dataWipe.js"
import { ONBOARDING_COMPLETED_KEY } from "@lectorium/stores/useOnboardingStore.js"

/**
 * The startup probe that skipped the rest of the run (#1738).
 *
 * `repositories()` throws SYNCHRONOUSLY when a database is missing, so the
 * `.catch(() => false)` `main.ts` chained onto `hasAny()` was never installed:
 * the rejection escaped `start()` into the last-resort handler, which mounted
 * the app and stopped — no `useAuthStore().restore()`, so no session and no
 * access token for the whole run.
 *
 * The precondition is the one `services/startup.ts` reaches on purpose: the
 * bootstrap reports `ready`, and the user database is null because opening it
 * failed. Below, a persistence stub that rejects `user.db` puts the composition
 * root in exactly that state.
 */

const SERVER: CdnServer = {
  id: "global",
  name: "Global",
  urlTemplate: "https://example.invalid/{path}",
  shareAudioUrl: "https://example.invalid/share/audio",
  shareVideoUrl: "https://example.invalid/share/video",
  authBaseUrl: "https://example.invalid/auth",
  chatBaseUrl: "https://example.invalid",
} as CdnServer

const USER_DB_PATH = "databases/lectorium/user.db"
const CONTENT_DB_PATH = "databases/lectorium/content.db"

function fakePreferences(initial: Record<string, string> = {}): IPreferences & {
  store: Map<string, string>
} {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
    remove: (key: string) => {
      store.delete(key)
      return Promise.resolve()
    },
  } as unknown as IPreferences & { store: Map<string, string> }
}

/** Composition root wired with a persistence adapter that opens the catalog and
 *  rejects the user DB — a corrupt `user.db`, a full disk, `SQLITE_NOTADB`
 *  after a bad import. Every port the probe does not touch is a stub. */
const deletedDbPaths: string[] = []

function initWithFailingUserDb(preferences: IPreferences): Lectorium {
  const open = vi.fn(async (path: string): Promise<IDatabase> => {
    if (path.endsWith("user.db")) throw new Error("file is not a database")
    return {
      query: async () => [],
      execute: async () => undefined,
      transaction: async (fn: () => Promise<void>) => fn(),
      save: async () => undefined,
      close: async () => undefined,
    }
  })

  const seed = {
    appConfig: {
      database: {
        localPathTemplate: CONTENT_DB_PATH,
        remotePathTemplate: "db/lectorium.{version}.db",
        userLocalPath: USER_DB_PATH,
      },
      publicRemoteConfigPath: "config.json",
    },
    persistence: { open, deleteDatabase: deletedDbPaths.push.bind(deletedDbPaths) },
    auth: { getSession: () => null, getAccessToken: () => Promise.resolve(null) },
    preferences,
    chatHttpRequest: () => Promise.resolve(new Response()),
    databaseTransferFactory: () => ({}),
    platform: "web",
    initialServer: SERVER,
  } as unknown as InitLectoriumSeed

  return initLectorium(seed)
}

afterEach(() => {
  deletedDbPaths.length = 0
  __resetLectoriumForTests()
})

describe("resetLocalUserDatabaseFromApp", () => {
  it("deletes the user DB from the very state the guard parks on (#1831)", async () => {
    const preferences = fakePreferences()
    const app = initWithFailingUserDb(preferences)

    await app.openContentDatabase(CONTENT_DB_PATH)
    await app.openUserDatabase(USER_DB_PATH).catch(() => undefined)
    expect(() => app.repositories()).toThrow(/user DB is not open/)

    await resetLocalUserDatabaseFromApp(app)

    // Against the real composition root: the reset works where every
    // repository-backed path — `wipeLocalUserData` included — cannot even start.
    expect(deletedDbPaths).toEqual([USER_DB_PATH])
  })
})

describe("resolveInitialRoute", () => {
  it("routes to the storage-error screen when the user DB failed to open", async () => {
    const preferences = fakePreferences()
    const app = initWithFailingUserDb(preferences)

    await app.openContentDatabase(CONTENT_DB_PATH)
    // What `startup.ts`'s `runUserDatabaseMigrations` swallows.
    await expect(app.openUserDatabase(USER_DB_PATH)).rejects.toThrow(/not a database/)

    // The reachable state the two issues share.
    expect(app.databases.content).not.toBeNull()
    expect(app.databases.user).toBeNull()

    await expect(resolveInitialRoute(app, preferences, true)).resolves.toBe(STORAGE_ERROR_PATH)
  })

  it("does not reject — the rest of startup (auth restore) depends on it", async () => {
    const preferences = fakePreferences()
    const app = initWithFailingUserDb(preferences)
    await app.openContentDatabase(CONTENT_DB_PATH)
    await app.openUserDatabase(USER_DB_PATH).catch(() => undefined)

    // `repositories()` throwing here is what used to escape `start()`.
    expect(() => app.repositories()).toThrow(/user DB is not open/)

    const settled = await Promise.allSettled([resolveInitialRoute(app, preferences, true)])
    expect(settled[0]!.status).toBe("fulfilled")
  })

  it("survives a repositories() that throws even with both databases present", async () => {
    // Belt and braces: the guard above reads `databases.user`, but the probe
    // must not depend on `repositories()` keeping its current failure mode.
    const preferences = fakePreferences()
    const app = {
      databases: { content: {}, user: {} },
      repositories: () => {
        throw new Error("repositories(): boom")
      },
    } as unknown as Lectorium

    await expect(resolveInitialRoute(app, preferences, true)).resolves.toBe("/onboarding")
  })

  it("routes to the storage-error screen when the bootstrap never became ready", async () => {
    const preferences = fakePreferences()
    const app = initWithFailingUserDb(preferences)

    await expect(resolveInitialRoute(app, preferences, false)).resolves.toBe(STORAGE_ERROR_PATH)
  })

  it("still sends an established user to Home when the databases are fine", async () => {
    const preferences = fakePreferences({ [ONBOARDING_COMPLETED_KEY]: "true" })
    const app = {
      databases: { content: {}, user: {} },
      repositories: () => {
        throw new Error("must not be probed once the flag is set")
      },
    } as unknown as Lectorium

    await expect(resolveInitialRoute(app, preferences, true)).resolves.toBe("/tabs/home")
  })

  it("infers an established user from listening history and stamps the flag", async () => {
    const preferences = fakePreferences()
    const app = {
      databases: { content: {}, user: {} },
      repositories: () => ({ listeningSessions: { hasAny: () => Promise.resolve(true) } }),
    } as unknown as Lectorium

    await expect(resolveInitialRoute(app, preferences, true)).resolves.toBe("/tabs/home")
    expect(preferences.store.get(ONBOARDING_COMPLETED_KEY)).toBe("true")
  })
})
