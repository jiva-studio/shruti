import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"

const TRACK_DURATION_MS = 60_000

function track(id: string): Track {
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
        title: `Lecture ${id}`,
        audios: [],
        audio: {
          path: `public/tracks/${id}/audio/original.mp3`,
          filesize: 1,
          duration: TRACK_DURATION_MS,
          kind: "original",
        },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

function item(n: number): PlaylistItem {
  return {
    id: `i-${n}` as PlaylistItemId,
    trackId: `t-${n}` as TrackId,
    addedAt: n,
    archivedAt: null,
    collectionId: null,
  }
}

let activeItems: PlaylistItem[] = []
let archivedItems: PlaylistItem[] = []
let everCompleted: Set<string> = new Set()
let listActiveFails = false
let writeFails = false
const tracksById = new Map<string, Track>()
/** Track ids handed to the prefetcher, in order. */
let prefetched: string[] = []
let prefetchedPages: string[][] = []

const repositories = {
  playlistItems: {
    listActive: async () => {
      if (listActiveFails) throw new Error("db closed")
      return activeItems
    },
    listArchived: async () => archivedItems,
    getById: async (id: string) =>
      activeItems.find((i) => i.id === id) ?? archivedItems.find((i) => i.id === id) ?? null,
    archive: async (id: string) => {
      const found = activeItems.find((i) => i.id === id)
      if (!found) return
      activeItems = activeItems.filter((i) => i.id !== id)
      archivedItems = [...archivedItems, { ...found, archivedAt: 1 }]
    },
    add: async (trackId: string) => {
      const created: PlaylistItem = {
        id: `i-of-${trackId}` as PlaylistItemId,
        trackId: trackId as TrackId,
        addedAt: 99,
        archivedAt: null,
        collectionId: null,
      }
      activeItems = [...activeItems, created]
      return created
    },
    remove: vi.fn(),
    clearAll: vi.fn(),
  },
  tracks: {
    getByIds: async (ids: readonly string[]) => {
      const out = new Map<string, Track>()
      for (const id of ids) {
        const t = tracksById.get(id)
        if (t) out.set(id, t)
      }
      return out
    },
    getById: async (id: string) => tracksById.get(id) ?? null,
  },
  authors: { getById: async () => null },
  listeningSessions: {
    getCompletedAtForItems: async () => new Map(),
    listEverCompletedItems: async (ids: readonly string[]) =>
      new Set(ids.filter((id) => everCompleted.has(id))),
  },
  unitOfWork: {
    run: async (fn: (tx: unknown) => unknown) => {
      if (writeFails) throw new Error("disk full")
      return fn({})
    },
  },
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: ref({ id: "server-a" }),
    repositories: () => repositories,
    storagePublicUrl: { get: (p: string) => `https://cdn.example.com/${p}` },
  }),
}))

const downloads = {
  cancelPrefetch: vi.fn(),
  evict: vi.fn(async () => true),
  markStartingDownload: vi.fn(),
}
vi.mock("@shruti/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => downloads,
}))

vi.mock("@shruti/stores/playlist/usePlaylistDerivedData.js", () => ({
  usePlaylistDerivedData: () => ({
    loadFor: async () => ({ progress: new Map(), completed: new Map() }),
  }),
}))
vi.mock("@shruti/stores/playlist/usePlaylistPrefetch.js", () => ({
  usePlaylistPrefetch: () => ({
    prefetchTrack: async (id: string) => {
      prefetched.push(id)
    },
    prefetchAll: (entries: readonly { track: { id: string } }[]) => {
      prefetchedPages.push(entries.map((e) => e.track.id))
    },
  }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync: vi.fn() }))

import { usePlaylistStore } from "../usePlaylistStore.js"

describe("usePlaylistStore — adding, removing and progress", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activeItems = [item(0), item(1), item(2)]
    archivedItems = []
    everCompleted = new Set()
    listActiveFails = false
    writeFails = false
    prefetched = []
    prefetchedPages = []
    tracksById.clear()
    for (const n of [0, 1, 2, 7]) tracksById.set(`t-${n}`, track(`t-${n}`))
    downloads.cancelPrefetch.mockClear()
    downloads.evict.mockClear()
  })

  describe("add", () => {
    it("puts the new lecture in the active list and prefetches it", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      const result = await store.add("t-7" as TrackId)

      expect(result.ok).toBe(true)
      expect(store.hasTrack("t-7" as TrackId)).toBe(true)
      expect(store.entries.map((e) => e.track.id)).toContain("t-7")
      expect(prefetched).toEqual(["t-7"])
    })

    it("refuses a lecture already in the active list, leaving it single", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      const result = await store.add("t-1" as TrackId)

      expect(result.ok).toBe(false)
      expect(result.ok ? null : result.error).toBe("already-in-playlist")
      expect(store.entries.filter((e) => e.track.id === "t-1")).toHaveLength(1)
      expect(prefetched).toEqual([])
    })

    it("reports a failed write and adds nothing", async () => {
      const store = usePlaylistStore()
      await store.refresh()
      writeFails = true

      const result = await store.add("t-7" as TrackId)

      expect(result.ok ? null : result.error).toBe("write-failed")
      expect(store.hasTrack("t-7" as TrackId)).toBe(false)
      expect(prefetched).toEqual([])
    })
  })

  describe("archiveByTrackId", () => {
    it("archives the item holding that track", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      const result = await store.archiveByTrackId("t-1" as TrackId)

      expect(result?.ok).toBe(true)
      expect(store.hasTrack("t-1" as TrackId)).toBe(false)
      expect(store.entries.map((e) => e.track.id)).toEqual(["t-0", "t-2"])
    })

    it("answers null for a track the playlist never held", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      expect(await store.archiveByTrackId("t-9" as TrackId)).toBeNull()
      expect(store.entries).toHaveLength(3)
    })
  })

  describe("the lifetime listened set", () => {
    it("marks a track completed even after its item was archived", async () => {
      everCompleted = new Set(["i-1"])
      const store = usePlaylistStore()
      await store.refresh()
      expect(store.hasCompletedTrack("t-1" as TrackId)).toBe(true)

      await store.archiveByTrackId("t-1" as TrackId)

      expect(store.hasCompletedTrack("t-1" as TrackId)).toBe(true)
      expect(store.hasCompletedTrack("t-0" as TrackId)).toBe(false)
    })
  })

  describe("patchProgress against the catalog duration", () => {
    it("leaves an item just short of the end unfinished", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      store.patchProgress("i-0" as PlaylistItemId, TRACK_DURATION_MS - 2001)

      expect(store.getProgressMs("i-0" as PlaylistItemId)).toBe(TRACK_DURATION_MS - 2001)
      expect(store.getCompletedAt("i-0" as PlaylistItemId)).toBeNull()
    })

    it("completes an item that reaches the threshold", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      store.patchProgress("i-0" as PlaylistItemId, TRACK_DURATION_MS - 2000)

      expect(store.getCompletedAt("i-0" as PlaylistItemId)).not.toBeNull()
    })

    it("cannot complete an item whose track is not loaded", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      store.patchProgress("i-unknown" as PlaylistItemId, TRACK_DURATION_MS)

      expect(store.getCompletedAt("i-unknown" as PlaylistItemId)).toBeNull()
    })
  })

  describe("refresh failing", () => {
    it("empties the list and keeps the reason", async () => {
      const store = usePlaylistStore()
      await store.refresh()
      listActiveFails = true

      await store.refresh()

      expect(store.error).toBe("db closed")
      expect(store.entries).toEqual([])
      expect(store.total).toBe(0)
      expect(store.hasTrack("t-1" as TrackId)).toBe(false)
      expect(store.hasCompletedTrack("t-1" as TrackId)).toBe(false)
      expect(store.isLoading).toBe(false)
    })
  })

  describe("loadMore", () => {
    it("does nothing when the whole list is already rendered", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      await store.loadMore()

      expect(store.hasMore).toBe(false)
      expect(store.entries).toHaveLength(3)
    })
  })

  describe("prefetchAll", () => {
    it("pre-warms the rendered head of the list", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      store.prefetchAll()

      expect(prefetchedPages).toEqual([["t-0", "t-1", "t-2"]])
    })
  })
})
