// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Behavioural test for the Lane E2b sign-in wiring in `useSyncEngine`: the
 * engine must stay dark while anonymous, run the first-sync backfill exactly
 * once per account (guarded by the device-local marker) the first time a real
 * account signs in, and always backfill *before* it pushes.
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
}))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ctx.lectorium }))
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
    }),
  }
})

describe("useSyncEngine — first-sync backfill", () => {
  it("stays dark while anonymous: no backfill, no sync", async () => {
    const app = mountEngine()
    await flush()

    expect(ctx.backfillLocal).not.toHaveBeenCalled()
    expect(ctx.runSync).not.toHaveBeenCalled()
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
