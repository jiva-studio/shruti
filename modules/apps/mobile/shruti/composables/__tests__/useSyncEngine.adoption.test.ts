// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runMigrations } from "@kit/persistence"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"

/**
 * Regression for #1827 — the anonymous→account handover dead-locking `user.db`.
 *
 * `maybeResetCursorForOwner` opens the SHARED reentrant unit of work and calls
 * `adoptAnonymousChanges`, which runs its own `unitOfWork.run`. Nesting is
 * proven by the transaction handle and nothing else, so a handle that is not
 * threaded down leaves the inner run queued behind the outer run's own pending
 * promise: neither settles, and every later write on the user database queues
 * behind them forever.
 *
 * The suites that fake the unit of work as `run: (fn) => fn()` cannot see any
 * of that. This one drives the REAL `createReentrantUnitOfWork` (built inside
 * `createSqlAppRepositories`) over an `IDatabase` whose `transaction()` calls
 * are serialised the way both shipping adapters serialise them.
 */

const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  shruti: null as unknown,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@usecases/sync/index.js", async (importOriginal) => ({
  // `adoptAnonymousChanges` is the writer under test — it runs for real. Only
  // the network cycle is stubbed out.
  ...(await importOriginal<Record<string, unknown>>()),
  runSync: (...a: unknown[]) => (ctx.runSync as unknown as (...x: unknown[]) => unknown)(...a),
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@shruti/shruti.js", () => ({ useShruti: () => ctx.shruti }))
vi.mock("@shruti/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({ refreshSessions: async () => {} }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ onSyncEvent: () => () => {} }))
vi.mock("@capacitor/app", () => ({
  App: { addListener: async () => ({ remove: async () => {} }) },
}))

import { useSyncEngine } from "../useSyncEngine.js"

/** Serialises `transaction()` callers through a promise chain, as both the
 *  Capacitor (`txQueue`) and sql.js adapters do. This queue is what turns an
 *  unrecognised nested run into a dead-lock rather than a second `BEGIN`. */
function withTxQueue(db: IDatabase): IDatabase {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    ...db,
    transaction(fn: () => Promise<void>): Promise<void> {
      const next = queue.then(() => db.transaction(fn))
      queue = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
  }
}

/** Drain the microtask queue so the void-ed async `sync()` cycles settle. A
 *  dead-locked unit of work never settles at any count. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

function mountEngine() {
  const app = createApp({
    setup() {
      useSyncEngine()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

const ANON = "anon-1"
const ACCOUNT = "user-2"

let db: IDatabase
let repos: SqlAppRepositories
let prefs: Map<string, string>

beforeEach(async () => {
  db = withTxQueue(await createInMemoryTestDatabase())
  await runMigrations(db, userMigrations)
  repos = createSqlAppRepositories({
    contentDb: db,
    userDb: db,
    getActiveLanguage: () => "en",
    getDeviceId: async () => "dev-1",
    getOwnerId: () => ctx.auth?.userId ?? null,
  })

  // The anonymous period's journal: one note the device wrote before signing
  // in, still owned by the anonymous identity.
  await repos.syncOutbox!.append({
    collection: "notes",
    docId: "n-anon",
    op: "upsert",
    data: { id: "n-anon" },
    hlc: "000001784000000:00000:dev-1",
    baseHlc: null,
    ownerId: ANON,
  })

  prefs = new Map([
    ["sync.cursorOwner", ANON],
    ["sync.cursorOwnerAnon", "1"],
    ["sync.cursorOwnerOrigin", "first-run"],
  ])
  ctx.auth = reactive({ signedIn: false, userId: null, anonymous: true })
  ctx.runSync = vi.fn(async () => ({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 }))
  ctx.shruti = {
    activeServer: ref({ profileBaseUrl: "https://profile.example" }),
    syncClient: {},
    preferences: {
      get: async (k: string) => prefs.get(k) ?? null,
      set: async (k: string, v: string) => {
        prefs.set(k, v)
      },
    },
    repositories: () => repos,
  }
})

/** A returning user: the anonymous session was this device's first run, and
 *  signing in cross-links to the account they already had, so `userId` flips. */
function signIn(): void {
  ctx.auth!.userId = ACCOUNT
  ctx.auth!.signedIn = true
  ctx.auth!.anonymous = false
}

describe("useSyncEngine — anonymous handover inside the shared unit of work (#1827)", () => {
  it("completes the handover instead of dead-locking on a nested run", async () => {
    const app = mountEngine()
    await flush()

    signIn()
    await flush()

    // The transaction committed: the journal changed hands and the cycle it
    // gates got to run. Without the handle none of this is reached — the outer
    // run is still awaiting the inner one, which is queued behind it.
    const rows = await db.query<{ owner_id: string; sent: number }>(
      "SELECT owner_id, sent FROM outbox WHERE doc_id = 'n-anon'"
    )
    expect(rows[0]).toMatchObject({ owner_id: ACCOUNT, sent: 0 })
    expect(prefs.get("sync.cursorOwner")).toBe(ACCOUNT)
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it("leaves the shared unit of work usable by every other writer", async () => {
    const app = mountEngine()
    await flush()
    signIn()
    await flush()

    // The blast radius of the dead-lock: notes, playlist, chat sessions,
    // listening sessions, downloads and the wipe all share this instance.
    let settled = false
    void repos.unitOfWork.run(async () => {
      settled = true
    })
    await flush()

    expect(settled).toBe(true)
    app.unmount()
  })
})
