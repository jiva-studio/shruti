import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { ITrackRepository, TrackListFilters } from "@lib/domain/ports/trackRepository.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { Track } from "@lib/domain/track.js"
import type {
  CollectionGroupRow,
  FeaturedCollectionRow,
  ISqlCollectionRepository,
} from "@infra/repositories/sql/collectionTypes.js"
import type { AppRepositories } from "@lectorium/repositories.js"

vi.mock("@lectorium/services/regionsRegistry.js", () => ({
  resolveAssetUrl: (key: string | undefined) => (key ? `https://cdn.example/${key}` : undefined),
}))

import {
  loadAllowedTopicIds,
  loadCollections,
  loadLectureCount,
  loadLecturePool,
} from "../landingSources.js"

/**
 * A double that answers only what a test wired up; any other member throws
 * rather than silently resolving to undefined.
 */
function stub<T extends object>(name: string, impl: Partial<T>): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      throw new Error(`${name}.${String(prop)} is not exercised by this test`)
    },
  }) as T
}

function repos(parts: {
  collections?: Partial<ISqlCollectionRepository>
  tracks?: Partial<ITrackRepository>
  topics?: Partial<ITopicRepository>
}): AppRepositories {
  return stub<AppRepositories>("repositories", {
    collections: stub<ISqlCollectionRepository>("collections", parts.collections ?? {}),
    tracks: stub<ITrackRepository>("tracks", parts.tracks ?? {}),
    topics: stub<ITopicRepository>("topics", parts.topics ?? {}),
  })
}

function collection(id: string, over: Partial<FeaturedCollectionRow> = {}): FeaturedCollectionRow {
  return { id, name: `Collection ${id}`, cover: `covers/${id}.jpg`, sort_order: 1, ...over }
}

function group(id: string): CollectionGroupRow {
  return { id, name: `Group ${id}`, description: "" }
}

function track(id: string): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2026-01-02",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [],
  }
}

const RU = "ru" as LanguageCode

describe("loadCollections", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("builds each shelf with absolute cover urls", async () => {
    const result = await loadCollections(
      repos({
        collections: {
          listGroups: async () => [group("g1")],
          listCollections: async () => [collection("c1", { description: "About karma" })],
          getGroupCollections: async () => [collection("c1")],
        },
      }),
      "en"
    )

    expect(result.groups).toEqual([
      {
        id: "g1",
        name: "Group g1",
        collections: [
          { id: "c1", name: "Collection c1", coverUrl: "https://cdn.example/covers/c1.jpg" },
        ],
      },
    ])
    expect(result.flat).toEqual([
      {
        id: "c1",
        name: "Collection c1",
        coverUrl: "https://cdn.example/covers/c1.jpg",
        description: "About karma",
      },
    ])
  })

  it("hides a shelf that holds no collections", async () => {
    const result = await loadCollections(
      repos({
        collections: {
          listGroups: async () => [group("empty"), group("full")],
          listCollections: async () => [],
          getGroupCollections: async (groupId) => (groupId === "full" ? [collection("c1")] : []),
        },
      }),
      "en"
    )

    expect(result.groups.map((g) => g.id)).toEqual(["full"])
  })

  it("reads every list in the requested locale", async () => {
    const locales: string[] = []
    await loadCollections(
      repos({
        collections: {
          listGroups: async (locale) => {
            locales.push(locale)
            return [group("g1")]
          },
          listCollections: async (locale) => {
            locales.push(locale)
            return []
          },
          getGroupCollections: async (_id, locale) => {
            locales.push(locale)
            return [collection("c1")]
          },
        },
      }),
      "ru"
    )

    expect(locales).toEqual(["ru", "ru", "ru"])
  })

  it("degrades to no shelves when the catalog read fails", async () => {
    const result = await loadCollections(
      repos({
        collections: {
          listGroups: async () => {
            throw new Error("no such table: collections")
          },
          listCollections: async () => [],
        },
      }),
      "en"
    )

    expect(result).toEqual({ groups: [], flat: [] })
  })

  it("degrades to no shelves when one group's read fails", async () => {
    const result = await loadCollections(
      repos({
        collections: {
          listGroups: async () => [group("g1")],
          listCollections: async () => [collection("c1")],
          getGroupCollections: async () => {
            throw new Error("db closed")
          },
        },
      }),
      "en"
    )

    expect(result).toEqual({ groups: [], flat: [] })
  })
})

describe("loadLecturePool", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("draws a pool restricted to the library languages", async () => {
    let seen: TrackListFilters | undefined
    let limit = -1
    const pool = await loadLecturePool(
      repos({
        tracks: {
          list: async (options) => {
            seen = options?.filters
            limit = options?.limit ?? -1
            return [track("t1")]
          },
        },
      }),
      [RU]
    )

    expect(pool.map((t) => t.id)).toEqual(["t1"])
    expect(seen?.languageCodes).toEqual([RU])
    expect(limit).toBe(40)
  })

  it("draws from every language when the user has picked none", async () => {
    let seen: TrackListFilters | undefined
    await loadLecturePool(
      repos({
        tracks: {
          list: async (options) => {
            seen = options?.filters
            return []
          },
        },
      }),
      []
    )

    expect(seen?.languageCodes).toBeUndefined()
  })

  it("degrades to an empty pool when the read fails", async () => {
    const pool = await loadLecturePool(
      repos({
        tracks: {
          list: async () => {
            throw new Error("db closed")
          },
        },
      }),
      [RU]
    )

    expect(pool).toEqual([])
  })
})

describe("loadAllowedTopicIds", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("does not filter at all when no language is picked", async () => {
    expect(await loadAllowedTopicIds(repos({}), [])).toBeNull()
  })

  it("answers the topics that have lectures in those languages", async () => {
    const allowed = await loadAllowedTopicIds(
      repos({ topics: { topicIdsWithTracksIn: async () => ["karma" as TopicId] } }),
      [RU]
    )

    expect(allowed?.has("karma" as TopicId)).toBe(true)
    expect(allowed?.has("bhakti" as TopicId)).toBe(false)
  })

  it("falls back to no filter when the read fails, rather than blanking the grid", async () => {
    const allowed = await loadAllowedTopicIds(
      repos({
        topics: {
          topicIdsWithTracksIn: async () => {
            throw new Error("db closed")
          },
        },
      }),
      [RU]
    )

    expect(allowed).toBeNull()
  })
})

describe("loadLectureCount", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("counts within the library languages", async () => {
    let seen: TrackListFilters | undefined
    const count = await loadLectureCount(
      repos({
        tracks: {
          count: async (filters) => {
            seen = filters
            return 12
          },
        },
      }),
      [RU]
    )

    expect(count).toBe(12)
    expect(seen).toEqual({ languageCodes: [RU] })
  })

  it("counts the whole catalogue when no language is picked", async () => {
    let seen: TrackListFilters | undefined = { languageCodes: [RU] }
    await loadLectureCount(
      repos({
        tracks: {
          count: async (filters) => {
            seen = filters
            return 0
          },
        },
      }),
      []
    )

    expect(seen).toBeUndefined()
  })

  it("answers null on failure so the shown count is kept, not zeroed", async () => {
    const count = await loadLectureCount(
      repos({
        tracks: {
          count: async () => {
            throw new Error("db closed")
          },
        },
      }),
      []
    )

    expect(count).toBeNull()
  })
})
