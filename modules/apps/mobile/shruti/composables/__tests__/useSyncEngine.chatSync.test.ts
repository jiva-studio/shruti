// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The engine's half of the "Sync chats" gate (#1848).
 *
 * The toggle used to gate journaling only, so a device with it off still
 * received every conversation started on the user's other devices. The pull
 * gate itself lives in `pullAndMerge`; what the engine owes it is the live flag
 * and the two things that make turning the toggle back on recover anything —
 * the gap watermark accessors, and re-arming the once-per-account backfill so
 * chat written while it was off gets an outbox row.
 */
const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  shruti: null as unknown,
  syncChats: null as unknown as { value: boolean },
  backfillLocal: null as unknown as ReturnType<typeof vi.fn>,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@usecases/sync/index.js", () => ({
  adoptAnonymousChanges: async () => ({ docs: 0 }),
  backfillLocal: (...a: unknown[]) =>
    (ctx.backfillLocal as unknown as (...x: unknown[]) => unknown)(...a),
  runSync: (...a: unknown[]) => (ctx.runSync as unknown as (...x: unknown[]) => unknown)(...a),
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@shruti/shruti.js", () => ({ useShruti: () => ctx.shruti }))
vi.mock("@shruti/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
vi.mock("@shruti/composables/useSyncChats.js", () => ({
  useSyncChatsEnabled: () => ctx.syncChats,
}))
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

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
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

/** The deps `runSync` was called with on its `n`-th invocation. */
function callDeps(n = 0): {
  isChatSyncEnabled?: () => boolean
  getChatGapCursor?: () => Promise<number | null>
  setChatGapCursor?: (c: number | null) => Promise<void>
} {
  return ctx.runSync.mock.calls[n]![0] as never
}

let prefs: Map<string, string>

beforeEach(() => {
  prefs = new Map()
  ctx.auth = reactive({ signedIn: true, userId: null, anonymous: false })
  ctx.syncChats = ref(true)
  ctx.backfillLocal = vi.fn(async () => ({ enqueued: 1, collections: ["chat_sessions"] }))
  ctx.runSync = vi.fn(async () => ({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 }))
  ctx.shruti = {
    activeServer: ref({ profileBaseUrl: "https://profile.example" }),
    syncClient: {},
    preferences: {
      get: async (k: string) => prefs.get(k) ?? null,
      set: async (k: string, v: string) => {
        prefs.set(k, v)
      },
      remove: async (k: string) => {
        prefs.delete(k)
      },
    },
    repositories: () => ({
      syncBackfill: {},
      syncOutbox: {},
      syncState: {},
      syncApply: {},
      unitOfWork: { run: (fn: () => unknown) => fn() },
      libraryItems: { listAll: async () => [] },
    }),
  }
})

describe("useSyncEngine — 'Sync chats' governs the pull too (#1848)", () => {
  it("hands the live toggle and the gap watermark to every cycle", async () => {
    ctx.syncChats.value = false
    const app = mountEngine()
    ctx.auth!.userId = "user-1"
    await flush()

    const deps = callDeps()
    expect(deps.isChatSyncEnabled?.()).toBe(false)

    // Read live, not captured — a flip in Settings gates the next cycle.
    ctx.syncChats.value = true
    expect(deps.isChatSyncEnabled?.()).toBe(true)
    app.unmount()
  })

  it("round-trips the gap floor through preferences", async () => {
    const app = mountEngine()
    ctx.auth!.userId = "user-1"
    await flush()

    const deps = callDeps()
    expect(await deps.getChatGapCursor?.()).toBeNull()

    await deps.setChatGapCursor?.(42)
    expect(await deps.getChatGapCursor?.()).toBe(42)

    // Cleared once a full re-pull has closed the gap.
    await deps.setChatGapCursor?.(null)
    expect(await deps.getChatGapCursor?.()).toBeNull()
    app.unmount()
  })

  it("re-arms the one-time backfill when the toggle goes back on", async () => {
    ctx.syncChats.value = false
    const app = mountEngine()
    ctx.auth!.userId = "user-1"
    await flush()

    // The account's backfill has run, so the marker is set and the in-memory
    // echo is armed — chat written from here on has no outbox row.
    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(prefs.get("sync.backfilled.user-1")).toBe("1")

    ctx.syncChats.value = true
    await flush()

    // Deleting the marker alone would not have done it: the guard reads the
    // in-memory echo first and would have skipped the backfill for the life of
    // the process, leaving everything written while off unuploadable.
    expect(ctx.backfillLocal).toHaveBeenCalledTimes(2)
    expect(ctx.runSync.mock.calls.length).toBeGreaterThan(1)
    app.unmount()
  })

  it("does not re-arm on the other flip, nor on the initial read", async () => {
    const app = mountEngine()
    ctx.auth!.userId = "user-1"
    await flush()
    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)

    ctx.syncChats.value = false
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
