// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runMigrations } from "@kit/persistence"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"

/**
 * Regression for #1882 — the handover being unreachable on every device that
 * ran the store build.
 *
 * The suites around this one all start from EMPTY preferences, which is a
 * fresh install and the one shape the bug does not touch: `sync.cursorOwner`
 * shipped three days before `sync.cursorOwnerOrigin`, so a real upgraded device
 * arrives with an owner recorded and no origin, takes the same-account branch
 * that passes the origin through, and can never stamp it. These fixtures are
 * that device: the markers the store build leaves, and the per-account backfill
 * marker the engine has written since it shipped.
 */

const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  shruti: null as unknown,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@usecases/sync/index.js", async (importOriginal) => ({
  // The handover runs for real — it is the outcome under test. Only the
  // network cycle is stubbed out.
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

/** Drain the microtask queue so the void-ed async `sync()` cycles settle. */
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
const OTHER = "user-9"

let db: IDatabase
let repos: SqlAppRepositories
let prefs: Map<string, string>
let setPref: ReturnType<typeof vi.fn>

/** Owner of the one journaled row, i.e. whether the handover happened. */
async function journalOwner(): Promise<string | null> {
  const rows = await db.query<{ owner_id: string | null }>(
    "SELECT owner_id FROM outbox WHERE doc_id = 'n-anon'"
  )
  return rows[0]?.owner_id ?? null
}

beforeEach(async () => {
  db = await createInMemoryTestDatabase()
  await runMigrations(db, userMigrations)
  repos = createSqlAppRepositories({
    contentDb: db,
    userDb: db,
    getActiveLanguage: () => "en",
    getDeviceId: async () => "dev-1",
    getOwnerId: () => ctx.auth?.userId ?? null,
  })

  // The anonymous period this device would strand: one note written before the
  // user signed in, journaled under the anonymous identity.
  await repos.syncOutbox!.append({
    collection: "notes",
    docId: "n-anon",
    op: "upsert",
    data: { id: "n-anon" },
    hlc: "000001784000000:00000:dev-1",
    baseHlc: null,
    ownerId: ANON,
  })

  // Exactly what the store build leaves behind: an owner, its anonymity, no
  // origin, no retired floor — plus the backfill marker of the only account
  // that has ever run a cycle here.
  prefs = new Map([
    ["sync.cursorOwner", ANON],
    ["sync.cursorOwnerAnon", "1"],
    [`sync.backfilled.${ANON}`, "1"],
  ])
  setPref = vi.fn(async (k: string, v: string) => {
    prefs.set(k, v)
  })
  ctx.auth = reactive({ signedIn: false, userId: ANON, anonymous: true })
  ctx.runSync = vi.fn(async () => ({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 }))
  ctx.shruti = {
    activeServer: ref({ profileBaseUrl: "https://profile.example" }),
    syncClient: {},
    preferences: {
      get: async (k: string) => prefs.get(k) ?? null,
      set: setPref,
      remove: async (k: string) => {
        prefs.delete(k)
      },
    },
    preferenceKeys: async () => [...prefs.keys()],
    repositories: () => repos,
  }
})

/** The returning user: sign-in cross-links to the account they already had, so
 *  `userId` flips away from the anonymous one. */
function signIn(): void {
  ctx.auth!.userId = ACCOUNT
  ctx.auth!.signedIn = true
  ctx.auth!.anonymous = false
}

describe("useSyncEngine — recovering the origin the store build never wrote (#1882)", () => {
  it("hands the anonymous journal over on a device upgraded from the store build", async () => {
    const app = mountEngine()
    await flush()

    // The upgrade's first cycle is what recovers the provenance: the device
    // carries no marker for any identity but this one.
    expect(prefs.get("sync.cursorOwnerOrigin")).toBe("first-run")

    signIn()
    await flush()

    expect(await journalOwner()).toBe(ACCOUNT)
    expect(prefs.get("sync.cursorOwner")).toBe(ACCOUNT)
    app.unmount()
  })

  it("recovers the origin at sign-in when no anonymous cycle preceded it", async () => {
    // Upgrade and sign-in inside one launch: the cycle that observes the switch
    // is the first one this build runs, so the recovery has to land there too.
    ctx.auth!.userId = null
    const app = mountEngine()
    await flush()

    signIn()
    await flush()

    expect(await journalOwner()).toBe(ACCOUNT)
    app.unmount()
  })

  it("stamps the recovered origin once, however many launches follow", async () => {
    for (let launch = 0; launch < 3; launch++) {
      const app = mountEngine()
      await flush()
      app.unmount()
    }

    const stamps = setPref.mock.calls.filter(([key]) => key === "sync.cursorOwnerOrigin")
    expect(stamps).toEqual([["sync.cursorOwnerOrigin", "first-run"]])

    const app = mountEngine()
    await flush()
    signIn()
    await flush()
    expect(await journalOwner()).toBe(ACCOUNT)
    app.unmount()
  })

  it("refuses when a retired floor records an identity before this one", async () => {
    prefs.set("sync.retiredOutboxId", "4")
    const app = mountEngine()
    await flush()

    signIn()
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBeUndefined()
    expect(await journalOwner()).toBe(ANON)
    app.unmount()
  })

  it("refuses when another account has run on this device", async () => {
    // The hole the retired floor cannot cover: signing out WIPES the journal
    // (#1773), so the switch that minted this anonymous identity read a tail of
    // 0 and left no floor. The account it replaced is remembered by its own
    // backfill marker, which the wipe does not touch — and whoever used the
    // phone after it may be a different person.
    prefs.set(`sync.backfilled.${OTHER}`, "1")
    const app = mountEngine()
    await flush()

    signIn()
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBeUndefined()
    expect(await journalOwner()).toBe(ANON)
    app.unmount()
  })

  it("refuses when the device cannot enumerate its own markers", async () => {
    // No evidence is not evidence of absence: without the key listing the
    // recovery cannot tell the two devices above apart, so it adopts neither.
    delete (ctx.shruti as { preferenceKeys?: unknown }).preferenceKeys
    const app = mountEngine()
    await flush()

    signIn()
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBeUndefined()
    expect(await journalOwner()).toBe(ANON)
    app.unmount()
  })

  it("leaves a signed-in owner's missing origin alone", async () => {
    // The recovery speaks only for anonymous owners. An account recorded here
    // has no provenance to recover — and the anonymous session that follows it
    // is `replaced` by construction.
    prefs.set("sync.cursorOwner", ACCOUNT)
    prefs.set("sync.cursorOwnerAnon", "0")
    ctx.auth!.userId = ACCOUNT
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    const app = mountEngine()
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBeUndefined()
    app.unmount()
  })
})
