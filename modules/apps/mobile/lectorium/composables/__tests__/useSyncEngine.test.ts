// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Behavioural test for the Lane E2b wiring in `useSyncEngine`: the engine stays
 * dark until a user identity exists, then runs for ANY identity — anonymous
 * device accounts included, so their data reaches the server even without a
 * sign-in. It runs the first-sync backfill exactly once per account (guarded by
 * the device-local marker) and always backfills *before* it pushes.
 *
 * Everything the composable pulls in (use cases, the Lectorium singleton, the
 * Pinia stores, the Capacitor App listener, the sync-event bus) is mocked
 * through a hoisted context object so the factories are initialised before the
 * composable's module graph loads.
 */
const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null } | null,
  lectorium: null as unknown,
  backfillLocal: null as unknown as ReturnType<typeof vi.fn>,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
  resumeCb: null as null | ((s: { isActive: boolean }) => void),
}))

vi.mock("@usecases/sync/index.js", () => ({
  backfillLocal: (...a: unknown[]) =>
    (ctx.backfillLocal as unknown as (...x: unknown[]) => unknown)(...a),
  runSync: (...a: unknown[]) => (ctx.runSync as unknown as (...x: unknown[]) => unknown)(...a),
  // Personal-library poll cadence (#1229). Kept idle here so the self-
  // rescheduling poll never fires a second cycle during these microtask flushes.
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ctx.lectorium }))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
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
  App: {
    addListener: async (_evt: string, cb: (s: { isActive: boolean }) => void) => {
      ctx.resumeCb = cb
      return { remove: async () => {} }
    },
  },
}))

import { useSyncEngine } from "../useSyncEngine.js"

/** Drain the microtask queue so the void-ed async `sync()` cycles settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Mount a throwaway component whose only job is to run the composable, so its
 *  `onMounted` / watchers fire under a real component instance. */
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

let prefs: Map<string, string>

beforeEach(() => {
  prefs = new Map()
  ctx.auth = reactive({ signedIn: false, userId: null })
  ctx.resumeCb = null
  ctx.backfillLocal = vi.fn(async () => ({ enqueued: 2, collections: ["notes"] }))
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
    repositories: () => ({
      syncBackfill: {},
      syncOutbox: {},
      syncState: {},
      syncApply: {},
      unitOfWork: {},
      libraryItems: { listAll: async () => [] },
    }),
  }
})

describe("useSyncEngine — first-sync backfill", () => {
  it("stays dark until an identity exists (no userId yet)", async () => {
    const app = mountEngine()
    await flush()

    expect(ctx.backfillLocal).not.toHaveBeenCalled()
    expect(ctx.runSync).not.toHaveBeenCalled()
    app.unmount()
  })

  it("syncs for an anonymous identity (userId set, never signed in)", async () => {
    const app = mountEngine()
    await flush()

    // Anonymous bootstrap resolves: a userId appears while signedIn stays false.
    ctx.auth!.userId = "anon-1"
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    expect(prefs.get("sync.backfilled.anon-1")).toBe("1")
    app.unmount()
  })

  it("on sign-in, backfills once (before pushing) and persists the per-account marker", async () => {
    const app = mountEngine()
    await flush()

    // Anonymous → real account on the same device (Upgrade-in-place).
    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    // Backfill runs strictly before the push cycle.
    expect(ctx.backfillLocal.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    // Marker written under the account id.
    expect(prefs.get("sync.backfilled.user-1")).toBe("1")
    app.unmount()
  })

  it("runs the backfill at most once per account across later cycles", async () => {
    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()
    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)

    // A later foreground-resume cycle must NOT re-run the backfill.
    ctx.resumeCb?.({ isActive: true })
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it("skips the backfill when the account was already backfilled on this device", async () => {
    prefs.set("sync.backfilled.user-2", "1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.backfillLocal).not.toHaveBeenCalled()
    // …but the normal sync cycle still runs.
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})

describe("useSyncEngine — cursor-ownership reset", () => {
  let setPullCursor: ReturnType<typeof vi.fn>
  let setAckedSeq: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setPullCursor = vi.fn(async () => {})
    setAckedSeq = vi.fn(async () => {})
    // Swap in a syncState that records the reset writes and a unit-of-work that
    // actually invokes its callback (the default mocks are opaque `{}`).
    ;(ctx.lectorium as { repositories: () => unknown }).repositories = () => ({
      syncBackfill: {},
      syncOutbox: {},
      syncState: { setPullCursor, setAckedSeq },
      syncApply: {},
      unitOfWork: { run: (fn: () => unknown) => fn() },
      libraryItems: { listAll: async () => [] },
    })
  })

  it("resets pull_cursor + acked_seq when a different account signs in on this device", async () => {
    // A prior account already owns the cursor on this device.
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).toHaveBeenCalledWith(0)
    expect(setAckedSeq).toHaveBeenCalledWith(0)
    // Ownership now records the new account, and the reset precedes the pull.
    expect(prefs.get("sync.cursorOwner")).toBe("user-2")
    expect(setPullCursor.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    app.unmount()
  })

  it("does NOT reset when the same account re-signs in (owner unchanged)", async () => {
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).not.toHaveBeenCalled()
    expect(setAckedSeq).not.toHaveBeenCalled()
    app.unmount()
  })

  it("first-ever owner records ownership without touching the (already-zero) cursor", async () => {
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).not.toHaveBeenCalled()
    expect(prefs.get("sync.cursorOwner")).toBe("user-1")
    app.unmount()
  })
})
