import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import type { CdnServer } from "@lib/domain/servers.js"

/* --------------------------------------------------------------------- */
/*                              Fixtures                                 */
/* --------------------------------------------------------------------- */

const SERVER: CdnServer = {
  id: "server-a",
  name: "Server A",
  urlTemplate: "https://a.example.com/{path}",
  shareAudioUrl: "https://a.example.com/excerpts",
  shareVideoUrl: "https://a.example.com/reels",
  authBaseUrl: "https://a.example.com/auth",
  chatBaseUrl: "https://a.example.com",
}

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
          duration: 60_000,
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

/** A playlist of `count` active items — bigger than one rendered page. */
function playlistOf(count: number): PlaylistItem[] {
  return Array.from({ length: count }, (_, n) => item(n))
}

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

let activeItems: PlaylistItem[] = []
let archivedItems: PlaylistItem[] = []
const tracksById = new Map<string, Track>()

const archive = vi.fn(async (id: string) => {
  const found = activeItems.find((i) => i.id === id)
  if (!found) return
  activeItems = activeItems.filter((i) => i.id !== id)
  archivedItems = [...archivedItems, { ...found, archivedAt: 1 }]
})
const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>(async () => null)

const repositories = {
  playlistItems: {
    listActive: vi.fn(async () => activeItems),
    listArchived: async () => archivedItems,
    getById: async (id: string) =>
      activeItems.find((i) => i.id === id) ?? archivedItems.find((i) => i.id === id) ?? null,
    archive: (id: string) => archive(id),
    add: vi.fn(),
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
  listeningSessions: { getCompletedAtForItems: async () => new Map() },
  unitOfWork: { run: async (fn: (tx: unknown) => unknown) => fn({}) },
}

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: ref(SERVER),
    repositories: () => repositories,
    mediaDownloader: { resolveLocalUrl: (url: string) => resolveLocalUrl(url) },
    storagePublicUrl: { get: (p: string) => `https://cdn.example.com/${p}` },
  }),
}))

const downloads = {
  cancelPrefetch: vi.fn(),
  evict: vi.fn(async () => true),
  markStartingDownload: vi.fn(),
}
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => downloads,
}))

const derived = { progress: new Map(), completed: new Map() }
vi.mock("@lectorium/stores/playlist/usePlaylistDerivedData.js", () => ({
  usePlaylistDerivedData: () => ({
    loadFor: async () => derived,
    mergeInto: () => derived,
  }),
}))
vi.mock("@lectorium/stores/playlist/usePlaylistPrefetch.js", () => ({
  usePlaylistPrefetch: () => ({ prefetchTrack: vi.fn(), prefetchAll: vi.fn() }),
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({ requestSync: vi.fn() }))

import { setNativeQueueRelease } from "@lectorium/services/nativeQueue.js"
import { usePlaylistStore } from "../usePlaylistStore.js"

/** Position past the first rendered page (PAGE_SIZE = 50). */
const OFF_PAGE = 60

describe("usePlaylistStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setNativeQueueRelease(null)
    activeItems = playlistOf(120)
    archivedItems = []
    tracksById.clear()
    for (const i of playlistOf(120)) tracksById.set(i.trackId, track(i.trackId))
    downloads.cancelPrefetch.mockClear()
    downloads.evict.mockClear()
    downloads.evict.mockImplementation(async () => true)
    repositories.playlistItems.listActive.mockClear()
    resolveLocalUrl.mockClear()
  })

  describe("lookups past the rendered page", () => {
    it("finds an item whose row Home has not paged in yet", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      expect(store.entries).toHaveLength(50)
      // Without this the Track screen / a chat citation opens the lecture with
      // no itemId, and playback is journaled under a synthetic `track:<id>`.
      expect(store.getEntryByTrackId(`t-${OFF_PAGE}` as TrackId)?.item.id).toBe(`i-${OFF_PAGE}`)
      expect(store.getEntryByItemId(`i-${OFF_PAGE}` as PlaylistItemId)?.track.id).toBe(
        `t-${OFF_PAGE}`
      )
    })

    it("builds a native queue starting past the page", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      const queue = await store.buildQueueFrom(`i-${OFF_PAGE}` as PlaylistItemId)

      expect(queue[0]?.itemId).toBe(`i-${OFF_PAGE}`)
      expect(queue).toHaveLength(50)
    })

    it("archives an off-page item — cancelling its prefetch and reclaiming its file", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      const result = await store.archive(`i-${OFF_PAGE}` as PlaylistItemId)

      expect(result.ok).toBe(true)
      expect(downloads.cancelPrefetch).toHaveBeenCalledWith(`t-${OFF_PAGE}`)
      expect(downloads.evict).toHaveBeenCalledWith(`t-${OFF_PAGE}`)
    })

    it("keeps the paged-in window across a refresh", async () => {
      const store = usePlaylistStore()
      await store.refresh()
      await store.loadMore()
      expect(store.entries).toHaveLength(100)

      // refresh() also runs mid-playback (auto-archive sweep, add, archive).
      await store.refresh()

      expect(store.entries).toHaveLength(100)
    })
  })

  describe("archiving a lecture the engine still holds", () => {
    it("takes it out of the native queue before deleting its audio", async () => {
      const order: string[] = []
      const release = vi.fn(async () => {
        order.push("release")
        return false
      })
      setNativeQueueRelease(release)
      downloads.evict.mockImplementation(async () => {
        order.push("evict")
        return true
      })
      const store = usePlaylistStore()
      await store.refresh()

      await store.archive("i-2" as PlaylistItemId)

      expect(release).toHaveBeenCalledWith("i-2")
      expect(order).toEqual(["release", "evict"])
    })

    it("keeps the file when the player cannot let go of it", async () => {
      setNativeQueueRelease(async () => true)
      const store = usePlaylistStore()
      await store.refresh()

      await store.archive("i-2" as PlaylistItemId)

      expect(downloads.evict).not.toHaveBeenCalled()
    })

    // The auto-archive sweep archives a run of finished lectures in one pass.
    // It goes through this entry point — not the use case — so the queue is
    // released before any file goes; re-hydration is its own single step.
    it("archives a swept item through the same contract, without re-hydrating", async () => {
      const order: string[] = []
      setNativeQueueRelease(async () => {
        order.push("release")
        return false
      })
      downloads.evict.mockImplementation(async () => {
        order.push("evict")
        return true
      })
      const store = usePlaylistStore()
      await store.refresh()
      repositories.playlistItems.listActive.mockClear()

      await store.archive("i-2" as PlaylistItemId, { refresh: false })

      expect(order).toEqual(["release", "evict"])
      expect(repositories.playlistItems.listActive).not.toHaveBeenCalled()
    })
  })

  describe("resolveTrackForItemId", () => {
    it("resolves an item archived while it was still queued", async () => {
      const store = usePlaylistStore()
      await store.refresh()
      await store.archive("i-2" as PlaylistItemId)

      expect(store.getEntryByItemId("i-2" as PlaylistItemId)).toBeUndefined()
      // The native queue outlives the active list: the player still has to be
      // able to name what the engine advanced onto.
      expect((await store.resolveTrackForItemId("i-2" as PlaylistItemId))?.id).toBe("t-2")
    })

    it("resolves the synthetic id used for playback outside the playlist", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      expect((await store.resolveTrackForItemId("track:t-7" as PlaylistItemId))?.id).toBe("t-7")
    })

    it("returns undefined for an id nothing knows about", async () => {
      const store = usePlaylistStore()
      await store.refresh()

      expect(await store.resolveTrackForItemId("i-nope" as PlaylistItemId)).toBeUndefined()
    })
  })
})
