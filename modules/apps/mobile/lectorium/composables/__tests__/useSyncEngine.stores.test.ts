// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, reactive, ref } from "vue"

const IDLE_DELAY_MS = 180_000
const PENDING_DELAY_MS = 5_000
const DEBOUNCE_MS = 3_000

interface RunSyncOptions {
  ownerId: string | null
  getLiveOwnerId: () => string | null
  isChatSyncEnabled: () => boolean
  refreshStores: (collections: readonly string[]) => Promise<void>
}

const ctx = vi.hoisted(() => ({
  auth: null as { userId: string | null; anonymous: boolean } | null,
  lectorium: null as unknown,
  lastRunSync: null as RunSyncOptions | null,
  runFails: false,
  cycles: 0,
  /** Rows each store holds after its last refresh. */
  playlistRows: 0,
  notesRows: 0,
  chatRows: 0,
  libraryRows: 0,
  serverRows: 0,
  playlistRefreshFails: false,
  syncRequestedHandler: null as null | (() => void),
  /** Repository reads that must throw, counted from the first. */
  failingReposReads: new Set<number>(),
  reposReads: 0,
  libraryItemsPending: false,
  libraryItemsFail: false,
  pendingSeen: [] as boolean[],
}))

vi.mock("@usecases/sync/index.js", () => ({
  adoptAnonymousChanges: async () => ({ docs: 0 }),
  backfillLocal: async () => ({ enqueued: 0, collections: [] }),
  runSync: async (options: RunSyncOptions) => {
    ctx.lastRunSync = options
    if (ctx.runFails) {
      ctx.runFails = false
      throw new Error("network down")
    }
    ctx.cycles++
    return { skipped: false, pulled: 0, pushed: 0, conflicts: 0 }
  },
  hasPendingLibraryItems: () => ctx.libraryItemsPending,
  nextSyncDelayMs: (hasPending: boolean) => {
    ctx.pendingSeen.push(hasPending)
    return hasPending ? PENDING_DELAY_MS : IDLE_DELAY_MS
  },
}))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ctx.lectorium }))
vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    refresh: async () => {
      if (ctx.playlistRefreshFails) throw new Error("playlist refresh failed")
      ctx.playlistRows = ctx.serverRows
    },
  }),
}))
vi.mock("@lectorium/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({
    refresh: async () => {
      ctx.notesRows = ctx.serverRows
    },
  }),
}))
vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    refreshSessions: async () => {
      ctx.chatRows = ctx.serverRows
    },
  }),
}))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({
    refresh: async () => {
      ctx.libraryRows = ctx.serverRows
    },
  }),
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({
  onSyncEvent: (_event: string, handler: () => void) => {
    ctx.syncRequestedHandler = handler
    return () => {
      ctx.syncRequestedHandler = null
    }
  },
}))
vi.mock("@capacitor/app", () => ({
  App: { addListener: async () => ({ remove: async () => {} }) },
}))
vi.mock("@lectorium/composables/useSyncChats.js", () => ({
  useSyncChatsEnabled: () => chatSyncEnabled,
}))
vi.mock("@lectorium/composables/syncBackfill.js", () => ({
  createBackfillGuard: () => ({ run: async () => {}, rearmForChats: async () => {} }),
}))
vi.mock("@lectorium/composables/syncChatGap.js", () => ({
  createChatGapCursor: () => ({ read: async () => null, write: async () => {} }),
}))
vi.mock("@lectorium/composables/syncCursorOwner.js", () => ({
  createCursorOwnerGuard: () => async () => {},
}))

const chatSyncEnabled = ref(true)

import { useSyncEngine } from "../useSyncEngine.js"

function mountEngine(): ReturnType<typeof createApp> {
  const app = createApp({
    setup() {
      useSyncEngine()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

function repositories() {
  ctx.reposReads++
  if (ctx.failingReposReads.has(ctx.reposReads)) throw new Error("repositories not open")
  return {
    syncOutbox: {},
    syncState: {},
    syncApply: {},
    unitOfWork: {},
    libraryItems: {
      listAll: async () => {
        if (ctx.libraryItemsFail) throw new Error("library table not open")
        return []
      },
    },
  }
}

describe("useSyncEngine — a cycle and its cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ctx.auth = reactive({ userId: "u1", anonymous: false })
    ctx.cycles = 0
    ctx.playlistRows = 0
    ctx.notesRows = 0
    ctx.chatRows = 0
    ctx.libraryRows = 0
    ctx.serverRows = 7
    ctx.playlistRefreshFails = false
    ctx.syncRequestedHandler = null
    ctx.failingReposReads = new Set()
    ctx.reposReads = 0
    ctx.libraryItemsPending = false
    ctx.libraryItemsFail = false
    ctx.pendingSeen = []
    chatSyncEnabled.value = true
    ctx.lastRunSync = null
    ctx.runFails = false
    ctx.lectorium = {
      activeServer: ref({ profileBaseUrl: "https://profile.example" }),
      syncClient: {},
      repositories,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("refreshing the stores a merge touched", () => {
    async function refreshFor(collections: readonly string[]): Promise<void> {
      const app = mountEngine()
      await flush()
      await ctx.lastRunSync!.refreshStores(collections)
      app.unmount()
    }

    it("re-reads the playlist when playlist rows merged", async () => {
      await refreshFor(["playlist_items"])

      expect(ctx.playlistRows).toBe(7)
      expect(ctx.notesRows).toBe(0)
      expect(ctx.chatRows).toBe(0)
      expect(ctx.libraryRows).toBe(0)
    })

    it("re-reads the playlist when listening sessions merged", async () => {
      await refreshFor(["listening_sessions"])

      expect(ctx.playlistRows).toBe(7)
    })

    it("re-reads the notes tab when notes merged", async () => {
      await refreshFor(["notes"])

      expect(ctx.notesRows).toBe(7)
      expect(ctx.playlistRows).toBe(0)
    })

    it("re-reads the chat history when a session or a message merged", async () => {
      await refreshFor(["chat_sessions"])
      expect(ctx.chatRows).toBe(7)

      ctx.chatRows = 0
      ctx.serverRows = 9
      await refreshFor(["chat_messages"])
      expect(ctx.chatRows).toBe(9)
    })

    it("re-reads the personal library when items or memberships merged", async () => {
      await refreshFor(["library_memberships"])

      expect(ctx.libraryRows).toBe(7)
    })

    it("re-reads nothing for a collection no store renders", async () => {
      await refreshFor(["sync_state"])

      expect([ctx.playlistRows, ctx.notesRows, ctx.chatRows, ctx.libraryRows]).toEqual([0, 0, 0, 0])
    })

    it("refreshes the remaining stores when one of them fails", async () => {
      ctx.playlistRefreshFails = true

      await refreshFor(["playlist_items", "notes"])

      expect(ctx.playlistRows).toBe(0)
      expect(ctx.notesRows).toBe(7)
    })
  })

  describe("what the cycle is told", () => {
    it("drains for the account that owns the device, live", async () => {
      const app = mountEngine()
      await flush()

      expect(ctx.lastRunSync!.ownerId).toBe("u1")
      ctx.auth!.userId = "u2"
      expect(ctx.lastRunSync!.getLiveOwnerId()).toBe("u2")
      app.unmount()
    })

    it("reads the chat toggle at the moment it is asked", async () => {
      const app = mountEngine()
      await flush()

      expect(ctx.lastRunSync!.isChatSyncEnabled()).toBe(true)
      chatSyncEnabled.value = false
      expect(ctx.lastRunSync!.isChatSyncEnabled()).toBe(false)
      app.unmount()
    })
  })

  describe("cycles that cannot run", () => {
    it("stays dark when the repositories are not open", async () => {
      ctx.failingReposReads = new Set([1, 2, 3, 4])

      const app = mountEngine()
      await flush()

      expect(ctx.cycles).toBe(0)
      app.unmount()
    })

    it("gives up the cycle when the databases close between the gate and the drain", async () => {
      ctx.failingReposReads = new Set([2])

      const app = mountEngine()
      await flush()

      expect(ctx.cycles).toBe(0)
      app.unmount()
    })

    it("runs the next cycle after one that threw", async () => {
      ctx.runFails = true
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

      const app = mountEngine()
      await flush()
      expect(ctx.cycles).toBe(0)

      await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS)
      expect(ctx.cycles).toBe(1)

      app.unmount()
      warn.mockRestore()
    })
  })

  describe("the poll cadence", () => {
    it("re-arms at the idle interval when nothing is being ingested", async () => {
      const app = mountEngine()
      await flush()
      expect(ctx.cycles).toBe(1)

      await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS - 1)
      expect(ctx.cycles).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.cycles).toBe(2)
      app.unmount()
    })

    it("polls in seconds while a library item is still being ingested", async () => {
      ctx.libraryItemsPending = true
      const app = mountEngine()
      await flush()

      await vi.advanceTimersByTimeAsync(PENDING_DELAY_MS)

      expect(ctx.cycles).toBe(2)
      app.unmount()
    })

    it("falls back to idle when the pending state cannot be read", async () => {
      ctx.libraryItemsPending = true
      ctx.libraryItemsFail = true
      const app = mountEngine()
      await flush()

      expect(ctx.pendingSeen[0]).toBe(false)
      await vi.advanceTimersByTimeAsync(PENDING_DELAY_MS)
      expect(ctx.cycles).toBe(1)

      await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS - PENDING_DELAY_MS)
      expect(ctx.cycles).toBe(2)
      app.unmount()
    })
  })

  describe("a local mutation asking for a push", () => {
    it("coalesces a burst into one cycle", async () => {
      const app = mountEngine()
      await flush()
      expect(ctx.cycles).toBe(1)

      ctx.syncRequestedHandler!()
      ctx.syncRequestedHandler!()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
      expect(ctx.cycles).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.cycles).toBe(2)
      app.unmount()
    })

    it("does not fire after the engine is gone", async () => {
      const app = mountEngine()
      await flush()
      ctx.syncRequestedHandler!()

      app.unmount()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + IDLE_DELAY_MS)

      expect(ctx.cycles).toBe(1)
    })
  })
})
