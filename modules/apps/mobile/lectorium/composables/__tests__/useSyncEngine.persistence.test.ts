// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runMigrations } from "@kit/persistence"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"
import {
  createPersistingTestDatabase,
  type PersistingTestDatabase,
} from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"

/**
 * The engine's two durable-marker paths, over the REAL repositories and the web
 * persistence adapter (#1631).
 *
 * Both write SQL through raw `db.execute` inside one transaction and then record
 * the fact in Preferences — localStorage, durable unconditionally. On web the
 * SQL half used to commit in memory only, so the marker outlived the work it
 * describes and neither path ever ran again: the backfill skipped an outbox it
 * had never really filled, and the cursor reset skipped a cursor still pointing
 * at the previous account's position.
 */

const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  lectorium: null as unknown,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@usecases/sync/index.js", async (importOriginal) => ({
  // `backfillLocal` and `adoptAnonymousChanges` run for real — they are the
  // writers under test. Only the network cycle is stubbed out.
  ...(await importOriginal<Record<string, unknown>>()),
  runSync: (...a: unknown[]) => (ctx.runSync as unknown as (...x: unknown[]) => unknown)(...a),
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ctx.lectorium }))
vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@lectorium/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => ({ refreshSessions: async () => {} }),
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({ onSyncEvent: () => () => {} }))
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

let store: PersistingTestDatabase
let db: IDatabase
let repos: SqlAppRepositories
/** Preferences are localStorage on web — durable no matter what SQLite did. */
let prefs: Map<string, string>

/** Runs `read` against the image a reload would open, not the live one. */
async function onReload<T>(read: (db: IDatabase) => Promise<T>): Promise<T> {
  const reloaded = await store.reload()
  try {
    return await read(reloaded)
  } finally {
    await reloaded.close()
  }
}

async function countRows(database: IDatabase, table: string): Promise<number> {
  const rows = await database.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

beforeEach(async () => {
  store = await createPersistingTestDatabase()
  db = store.db
  await runMigrations(db, userMigrations)
  repos = createSqlAppRepositories({
    contentDb: db,
    userDb: db,
    getActiveLanguage: () => "en",
    getDeviceId: async () => "dev-1",
    getOwnerId: () => ctx.auth?.userId ?? null,
  })

  prefs = new Map()
  ctx.auth = reactive({ signedIn: false, userId: null, anonymous: true })
  ctx.runSync = vi.fn(async () => ({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 }))
  ctx.lectorium = {
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

describe("useSyncEngine — first-sync backfill durability", () => {
  beforeEach(async () => {
    // A note written before this device ever synced: no outbox row, no
    // `sync_doc_hlc`. Raw SQL so the journal decorator never sees it.
    await db.execute(
      `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at)
       VALUES ('n-1', 'tr-1', 'pre-sync note', 0, 1, 1784000000000)`
    )
    await db.save()
  })

  it("persists the enqueue before it records the marker that skips it forever", async () => {
    const engine = mountEngine()
    await flush()

    ctx.auth!.userId = "user-1"
    await flush()

    // In memory the backfill worked, and the marker says it never has to run again.
    expect(await countRows(db, "outbox")).toBe(1)
    expect(prefs.get("sync.backfilled.user-1")).toBe("1")

    // The marker lives in localStorage and always survives. If the enqueue does
    // not, the account's pre-sync notes and playlist never upload — the guard at
    // the top of `maybeBackfill` short-circuits on every later launch.
    expect(await onReload((d) => countRows(d, "outbox"))).toBe(1)
    engine.unmount()
  })

  it("relaunches into a state where the backfill is genuinely done", async () => {
    const first = mountEngine()
    await flush()
    ctx.auth!.userId = "user-1"
    await flush()
    first.unmount()

    // Reopen the persisted image the way a cold start would, keeping the same
    // Preferences, and let the engine run again against it.
    const reloaded = await store.reload()
    repos = createSqlAppRepositories({
      contentDb: reloaded,
      userDb: reloaded,
      getActiveLanguage: () => "en",
      getDeviceId: async () => "dev-1",
      getOwnerId: () => ctx.auth?.userId ?? null,
    })
    const second = mountEngine()
    await flush()

    expect(prefs.get("sync.backfilled.user-1")).toBe("1")
    expect(await countRows(reloaded, "outbox")).toBe(1)
    const rows = await reloaded.query<{ collection: string; doc_id: string }>(
      "SELECT collection, doc_id FROM outbox"
    )
    expect(rows).toEqual([{ collection: "notes", doc_id: "n-1" }])
    second.unmount()
    await reloaded.close()
  })
})

describe("useSyncEngine — cursor-ownership reset durability", () => {
  beforeEach(async () => {
    // The previous account's high-water mark in the server's change log.
    await repos.syncState!.setPullCursor(42)
    await repos.syncState!.setAckedSeq(42)
    await db.save()
    prefs.set("sync.cursorOwner", "user-1")
    prefs.set("sync.cursorOwnerAnon", "0")
  })

  it("persists the reset before it records the new owner", async () => {
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    ctx.auth!.anonymous = false
    await flush()

    expect(await repos.syncState!.getPullCursor()).toBe(0)
    expect(prefs.get("sync.cursorOwner")).toBe("user-2")

    // Ownership moved durably; the cursor has to move with it. Left behind, it
    // keeps skipping every change of user-2's whose `global_seq` sits below 42,
    // and the owner marker means the guard never looks again.
    expect(
      await onReload(async (d) => {
        const rows = await d.query<{ pull_cursor: number }>(
          "SELECT pull_cursor FROM sync_state WHERE device_id = 'dev-1'"
        )
        return Number(rows[0]!.pull_cursor)
      })
    ).toBe(0)
    app.unmount()
  })

  it("persists the retired-outbox watermark it stamps on the switch", async () => {
    await repos.syncOutbox!.append({
      collection: "notes",
      docId: "n-old",
      op: "upsert",
      data: { id: "n-old" },
      hlc: "1|0|dev-1",
      baseHlc: "",
      ownerId: "user-1",
    })
    await db.save()

    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    ctx.auth!.anonymous = false
    await flush()

    // The previous owner's un-pushed rows must stay retired across a reload —
    // otherwise the next cycle pushes user-1's notes under user-2 (#1497).
    expect(
      await onReload(async (d) => {
        const rows = await d.query<{ pushed_outbox_id: number }>(
          "SELECT pushed_outbox_id FROM sync_state WHERE device_id = 'dev-1'"
        )
        return Number(rows[0]!.pushed_outbox_id)
      })
    ).toBeGreaterThan(0)
    app.unmount()
  })
})
