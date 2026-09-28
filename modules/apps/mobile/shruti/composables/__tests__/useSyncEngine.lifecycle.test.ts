// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

/**
 * Lifecycle of the sync trigger: a trigger that arrives while a cycle is in
 * flight is run once that cycle ends, and nothing the composable started
 * outlives its unmount — neither the poll timer armed after an await nor the
 * `appStateChange` listener whose handle resolves late.
 */
type ResumeListener = (state: { isActive: boolean }) => void
type ListenerHandle = { remove: () => Promise<void> }

const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  shruti: null as unknown,
  runSync: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  addListener: null as unknown as Mock<
    (event: string, cb: ResumeListener) => Promise<ListenerHandle>
  >,
}))

vi.mock("@usecases/sync/index.js", () => ({
  adoptAnonymousChanges: async () => ({ docs: 0 }),
  backfillLocal: async () => ({ enqueued: 0, collections: [] }),
  runSync: (...a: unknown[]) => ctx.runSync(...a),
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@shruti/shruti.js", () => ({ useShruti: () => ctx.shruti }))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
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
  App: {
    addListener: (event: string, cb: ResumeListener) => ctx.addListener(event, cb),
  },
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

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const SYNC_RESULT = { skipped: false, pulled: 0, pushed: 0, conflicts: 0 }
let listAll: () => Promise<readonly unknown[]>

beforeEach(() => {
  vi.useFakeTimers()
  ctx.auth = reactive({ signedIn: true, userId: "user-1", anonymous: false })
  ctx.runSync = vi.fn(async () => SYNC_RESULT)
  ctx.addListener = vi.fn(async () => ({ remove: async () => {} }))
  listAll = async () => []
  const prefs = new Map<string, string>([
    ["sync.cursorOwner", "user-1"],
    ["sync.cursorOwnerAnon", "0"],
    ["sync.backfilled.user-1", "1"],
  ])
  ctx.shruti = {
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
      libraryItems: { listAll: () => listAll() },
    }),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useSyncEngine — trigger while a cycle is in flight", () => {
  it("runs one more cycle for the new identity once the current one ends", async () => {
    const first = deferred<typeof SYNC_RESULT>()
    ctx.runSync.mockImplementationOnce(() => first.promise)
    const app = mountEngine()
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)

    // Sign-in lands while the launch cycle is still pushing.
    ctx.auth!.userId = "user-2"
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)

    first.resolve(SYNC_RESULT)
    await flush()

    expect(ctx.runSync).toHaveBeenCalledTimes(2)
    expect(ctx.runSync.mock.calls[1]![0]).toMatchObject({ ownerId: "user-2" })
    app.unmount()
  })

  it("coalesces several triggers during one cycle into a single re-run", async () => {
    const first = deferred<typeof SYNC_RESULT>()
    ctx.runSync.mockImplementationOnce(() => first.promise)
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    await flush()
    ctx.auth!.userId = "user-3"
    await flush()

    first.resolve(SYNC_RESULT)
    await flush()

    expect(ctx.runSync).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it("does not re-run a cycle nobody asked for again", async () => {
    const app = mountEngine()
    await flush()
    await flush()

    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})

describe("useSyncEngine — poll timer", () => {
  it("keeps one poll timer when two re-arms overlap", async () => {
    let resumeCb: (s: { isActive: boolean }) => void = () => undefined
    ctx.addListener.mockImplementation(async (_e: string, cb: typeof resumeCb) => {
      resumeCb = cb
      return { remove: async () => {} }
    })
    const reads: Deferred<readonly unknown[]>[] = []
    listAll = () => {
      const read = deferred<readonly unknown[]>()
      reads.push(read)
      return read.promise
    }
    const app = mountEngine()
    await flush()
    // The launch cycle is re-arming; a resume starts a second re-arm meanwhile.
    resumeCb({ isActive: true })
    await flush()
    expect(reads).toHaveLength(2)

    for (const read of reads) read.resolve([])
    await flush()

    expect(vi.getTimerCount()).toBe(1)
    app.unmount()
  })
})

describe("useSyncEngine — nothing outlives unmount", () => {
  it("arms no poll when the pending-state read settles after unmount", async () => {
    const pending = deferred<readonly unknown[]>()
    listAll = () => pending.promise
    const app = mountEngine()
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)

    app.unmount()
    pending.resolve([])
    await flush()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps the appStateChange listener while mounted and removes it on unmount", async () => {
    const remove = vi.fn(async () => {})
    ctx.addListener.mockImplementation(async () => ({ remove }))
    const app = mountEngine()
    await flush()
    expect(remove).not.toHaveBeenCalled()

    app.unmount()
    await flush()

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("removes an appStateChange listener whose handle resolves after unmount", async () => {
    const handle = deferred<ListenerHandle>()
    const remove = vi.fn(async () => {})
    ctx.addListener.mockImplementation(() => handle.promise)
    const app = mountEngine()
    await flush()

    app.unmount()
    handle.resolve({ remove })
    await flush()

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("ignores a resume event delivered after unmount", async () => {
    let resumeCb: (s: { isActive: boolean }) => void = () => undefined
    ctx.addListener.mockImplementation(async (_e: string, cb: typeof resumeCb) => {
      resumeCb = cb
      return { remove: async () => {} }
    })
    const app = mountEngine()
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)

    app.unmount()
    resumeCb({ isActive: true })
    await flush()

    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not re-run a cycle that was requested before unmount", async () => {
    const first = deferred<typeof SYNC_RESULT>()
    ctx.runSync.mockImplementationOnce(() => first.promise)
    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-2"
    await flush()

    app.unmount()
    first.resolve(SYNC_RESULT)
    await flush()

    expect(ctx.runSync).toHaveBeenCalledTimes(1)
  })
})
