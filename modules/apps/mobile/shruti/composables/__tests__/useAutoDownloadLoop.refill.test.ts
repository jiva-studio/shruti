// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, reactive, ref, type Ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackListQuery } from "@lib/domain/ports/trackRepository.js"

const HOUR_MS = 3_600_000

const ctx = vi.hoisted(() => ({
  config: null as unknown as Map<string, Ref<unknown>>,
  filters: null as unknown as Record<string, unknown>,
  subscribed: true,
  databases: { content: {} as object | null, user: {} as object | null },
  /** The catalog, in default order. */
  library: [] as Track[],
  activeItems: [] as PlaylistItem[],
  archivedItems: [] as PlaylistItem[],
  progressMs: new Map<string, number>(),
  completedAt: new Map<string, number>(),
  /** Track ids the loop added, in order. */
  added: [] as string[],
  addOutcome: null as null | { ok: false; error: string },
  listFails: false,
  listQueries: [] as TrackListQuery[],
}))

function track(id: string, durationMs: number): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2020-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        trackId: id as TrackId,
        language: "en",
        title: id,
        audios: [],
        audio: { path: `${id}.mp3`, filesize: 1, duration: durationMs, kind: "original" },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

function playlistItem(id: string, trackId: string): PlaylistItem {
  return {
    id: id as PlaylistItemId,
    trackId: trackId as TrackId,
    addedAt: 1,
    archivedAt: null,
    collectionId: null,
  }
}

vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (key: string, initial: unknown) => {
    const existing = ctx.config.get(key)
    if (existing) return existing
    const created = ref(initial)
    ctx.config.set(key, created)
    return created
  },
}))
vi.mock("@shruti/stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => ctx.filters,
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    get entries() {
      return ctx.activeItems
        .map((i) => ({ item: i, track: ctx.library.find((t) => t.id === i.trackId) }))
        .filter((e): e is { item: PlaylistItem; track: Track } => !!e.track)
    },
    completedAtMap: new Map(),
    getCompletedAt: (itemId: string) => ctx.completedAt.get(itemId) ?? null,
    getProgressMs: (itemId: string) => ctx.progressMs.get(itemId) ?? 0,
    add: async (trackId: string) => {
      if (ctx.addOutcome) return ctx.addOutcome
      ctx.added.push(trackId)
      const item = playlistItem(`i-of-${trackId}`, trackId)
      ctx.activeItems = [...ctx.activeItems, item]
      return { ok: true as const, value: item }
    },
  }),
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    get isSubscribed() {
      return ctx.subscribed
    },
  }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    databases: ctx.databases,
    repositories: () => ({
      playlistItems: {
        listActive: async () => ctx.activeItems,
        listArchived: async () => ctx.archivedItems,
      },
      tracks: {
        getByIds: async (ids: readonly string[]) =>
          new Map(
            ids
              .map((id) => [id, ctx.library.find((t) => t.id === id)] as const)
              .filter((pair): pair is readonly [string, Track] => !!pair[1])
          ),
        list: async (query: TrackListQuery) => {
          ctx.listQueries.push(query)
          if (ctx.listFails) throw new Error("content db closed")
          const offset = query.offset ?? 0
          return ctx.library.slice(offset, offset + (query.limit ?? 50))
        },
      },
    }),
  }),
}))

import { AUTO_DOWNLOAD_TARGET_SECONDS_KEY, useAutoDownloadLoop } from "../useAutoDownloadLoop.js"

async function flush(): Promise<void> {
  for (let i = 0; i < 120; i++) await Promise.resolve()
}

function mountLoop(): ReturnType<typeof createApp> {
  const app = createApp({
    setup() {
      useAutoDownloadLoop()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

/** Mount, let the first refill run to the end, unmount. */
async function runLoop(): Promise<void> {
  const app = mountLoop()
  await flush()
  app.unmount()
}

describe("useAutoDownloadLoop — filling the queue", () => {
  beforeEach(() => {
    ctx.config = new Map<string, Ref<unknown>>([[AUTO_DOWNLOAD_TARGET_SECONDS_KEY, ref(7200)]])
    ctx.filters = reactive({
      authorIds: [],
      locationIds: [],
      languageCodes: [],
      sourceIds: [],
      tagIds: [],
      topicIds: [],
      duration: [],
      sort: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      load: async () => {},
    })
    ctx.subscribed = true
    ctx.databases = { content: {}, user: {} }
    ctx.library = Array.from({ length: 8 }, (_, n) => track(`t-${n}`, HOUR_MS))
    ctx.activeItems = []
    ctx.archivedItems = []
    ctx.progressMs = new Map()
    ctx.completedAt = new Map()
    ctx.added = []
    ctx.addOutcome = null
    ctx.listFails = false
    ctx.listQueries = []
  })

  it("adds lectures until the queued hours reach the target", async () => {
    await runLoop()

    expect(ctx.added).toEqual(["t-0", "t-1"])
  })

  it("counts what is left of a half-listened lecture, not its whole length", async () => {
    ctx.activeItems = [playlistItem("i-0", "t-0")]
    ctx.progressMs.set("i-0", HOUR_MS / 2)

    await runLoop()

    // Half an hour queued, so two more hours are needed to pass the target.
    expect(ctx.added).toEqual(["t-1", "t-2"])
  })

  it("counts a finished lecture as nothing", async () => {
    ctx.activeItems = [playlistItem("i-0", "t-0")]
    ctx.completedAt.set("i-0", 1)

    await runLoop()

    expect(ctx.added).toEqual(["t-1", "t-2"])
  })

  it("never re-adds a lecture the user archived", async () => {
    ctx.archivedItems = [playlistItem("i-old", "t-0"), playlistItem("i-old2", "t-1")]

    await runLoop()

    expect(ctx.added).toEqual(["t-2", "t-3"])
  })

  it("walks to the next page when the whole first one is already queued", async () => {
    ctx.library = Array.from({ length: 60 }, (_, n) => track(`t-${n}`, HOUR_MS))
    ctx.archivedItems = ctx.library.slice(0, 50).map((t, n) => playlistItem(`i-${n}`, t.id))

    await runLoop()

    expect(ctx.listQueries.map((q) => q.offset)).toEqual([0, 50, 50])
    expect(ctx.added).toEqual(["t-50", "t-51"])
  })

  it("stops when the library runs out", async () => {
    ctx.library = [track("t-0", HOUR_MS)]

    await runLoop()

    expect(ctx.added).toEqual(["t-0"])
  })

  it("leaves the library alone when the loaded page already meets the target", async () => {
    ctx.activeItems = [playlistItem("i-0", "t-0"), playlistItem("i-1", "t-1")]

    await runLoop()

    expect(ctx.listQueries).toEqual([])
    expect(ctx.added).toEqual([])
  })

  it("stops on the first add the store refused", async () => {
    ctx.addOutcome = { ok: false, error: "write-failed" }

    await runLoop()

    expect(ctx.added).toEqual([])
    expect(ctx.listQueries).toHaveLength(1)
  })

  it("survives a library read that failed", async () => {
    ctx.listFails = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await runLoop()

    expect(ctx.added).toEqual([])
    warn.mockRestore()
  })

  describe("the gates", () => {
    it("stays off for a user without a subscription", async () => {
      ctx.subscribed = false

      await runLoop()

      expect(ctx.listQueries).toEqual([])
    })

    it("stays off while the target is zero", async () => {
      ctx.config.set(AUTO_DOWNLOAD_TARGET_SECONDS_KEY, ref(0))

      await runLoop()

      expect(ctx.listQueries).toEqual([])
    })

    it("waits for the databases to open", async () => {
      ctx.databases = { content: null, user: null }

      await runLoop()

      expect(ctx.listQueries).toEqual([])
    })

    it("fills once the subscription arrives", async () => {
      ctx.subscribed = false
      const app = mountLoop()
      await flush()
      expect(ctx.added).toEqual([])

      ctx.subscribed = true
      ctx.config.get(AUTO_DOWNLOAD_TARGET_SECONDS_KEY)!.value = 3600
      await flush()

      expect(ctx.added).toEqual(["t-0"])
      app.unmount()
    })
  })
})
