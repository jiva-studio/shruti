// @vitest-environment jsdom
/**
 * Attribution for every cited track in one message, resolved once and
 * re-localized on a language switch. What the copy/share export prints under a
 * citation comes from here, so a track missing from the local catalog and a
 * repository that throws both have to end in something renderable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, ref, type App, type ComputedRef, type Ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"

/* -- Module doubles ----------------------------------------------------- */

interface Catalog {
  readonly trackLoads: string[]
  readonly authorLoads: string[]
  tracks: Map<string, Track>
  authors: Map<string, Author>
  throwsFor: Set<string>
}

const catalog = vi.hoisted<Catalog>(() => ({
  trackLoads: [],
  authorLoads: [],
  tracks: new Map(),
  authors: new Map(),
  throwsFor: new Set(),
}))

const libraryLanguages = vi.hoisted(() => ({ value: ["en"] as readonly string[] }))
const dictionaryLoads = vi.hoisted(() => ({ count: 0 }))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      tracks: {
        getById: async (id: string) => {
          catalog.trackLoads.push(id)
          if (catalog.throwsFor.has(id)) throw new Error("db closed")
          return catalog.tracks.get(id) ?? null
        },
      },
      authors: {
        getById: async (id: string) => {
          catalog.authorLoads.push(id)
          return catalog.authors.get(id) ?? null
        },
      },
    }),
  }),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguages,
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => void (dictionaryLoads.count += 1),
    sourcesById: new Map(),
  }),
}))

const { useCitationMetadata } = await import("../useCitationMetadata.js")

/* -- Fixtures ----------------------------------------------------------- */

function variant(language: LanguageCode, title: string): TrackVariant {
  return {
    trackId: "t-1" as TrackId,
    language,
    title,
    audios: [],
    audio: null,
    transcript: null,
    outline: null,
    description: null,
  }
}

function makeTrack(id: string, over: Partial<Track> = {}): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "1972-08-14",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant("en", "Happiness Beyond The Senses")],
    ...over,
  }
}

function makeAuthor(names: Record<string, string>): Author {
  return {
    id: "a-1" as AuthorId,
    names: new Map(Object.entries(names) as [LanguageCode, string][]),
  }
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

interface Mounted {
  readonly meta: ComputedRef<Map<string, { trackTitle: string; authorName: string }>>
  readonly ids: Ref<string[]>
  readonly lang: Ref<string>
}

function mountMetadata(ids: string[], lang = "en"): Mounted {
  const idsRef = ref(ids)
  const langRef = ref(lang)
  let meta!: ComputedRef<Map<string, { trackTitle: string; authorName: string }>>
  app = createApp({
    setup() {
      meta = useCitationMetadata(
        () => idsRef.value,
        () => langRef.value
      )
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return { meta, ids: idsRef, lang: langRef }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  catalog.trackLoads.length = 0
  catalog.authorLoads.length = 0
  catalog.tracks = new Map()
  catalog.authors = new Map()
  catalog.throwsFor = new Set()
  libraryLanguages.value = ["en"]
  dictionaryLoads.count = 0
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.restoreAllMocks()
})

/* -- Cases -------------------------------------------------------------- */

describe("useCitationMetadata", () => {
  it("resolves the title and the author of a cited track", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1", { authorId: "a-1" as AuthorId }))
    catalog.authors.set("a-1", makeAuthor({ en: "A.C. Bhaktivedanta Swami" }))

    const { meta } = mountMetadata(["t-1"])
    await flush()

    expect(meta.value.get("t-1")).toMatchObject({
      trackTitle: "Happiness Beyond The Senses",
      authorName: "A.C. Bhaktivedanta Swami",
      trackDate: "1972-08-14",
    })
  })

  it("holds an entry with empty fields for a track the catalog lost", async () => {
    const { meta } = mountMetadata(["t-missing"])
    await flush()

    expect(meta.value.get("t-missing")).toEqual({
      trackTitle: "",
      authorName: "",
      reference: "",
      trackDate: "",
    })
  })

  it("leaves an unauthored track's author blank without a lookup", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))

    const { meta } = mountMetadata(["t-1"])
    await flush()

    expect(meta.value.get("t-1")?.authorName).toBe("")
    expect(catalog.authorLoads).toEqual([])
  })

  it("is empty until the load resolves, rather than throwing on a half-loaded map", () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))

    const { meta } = mountMetadata(["t-1"])

    expect(meta.value.size).toBe(0)
  })

  it("resolves every cite of the message", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))
    catalog.tracks.set("t-2", makeTrack("t-2", { variants: [variant("en", "Second lecture")] }))

    const { meta } = mountMetadata(["t-1", "t-2"])
    await flush()

    expect([...meta.value.keys()].sort()).toEqual(["t-1", "t-2"])
    expect(meta.value.get("t-2")?.trackTitle).toBe("Second lecture")
  })

  it("loads a track cited twice in the same message only once", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))

    mountMetadata(["t-1", "t-1"])
    await flush()

    expect(catalog.trackLoads).toEqual(["t-1"])
  })

  it("keeps what it has and loads only the newly cited track", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))
    catalog.tracks.set("t-2", makeTrack("t-2", { variants: [variant("en", "Second lecture")] }))

    const { meta, ids } = mountMetadata(["t-1"])
    await flush()

    ids.value = ["t-1", "t-2"]
    await flush()

    expect(catalog.trackLoads).toEqual(["t-1", "t-2"])
    expect([...meta.value.keys()].sort()).toEqual(["t-1", "t-2"])
  })

  it("does not retry a track it already failed to find", async () => {
    const { meta, ids } = mountMetadata(["t-missing"])
    await flush()

    ids.value = ["t-missing", "t-missing"]
    await flush()

    expect(catalog.trackLoads).toEqual(["t-missing"])
    expect(meta.value.has("t-missing")).toBe(true)
  })

  it("leaves a track out of the map when the repository throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    catalog.throwsFor.add("t-1")

    const { meta } = mountMetadata(["t-1"])
    await flush()

    expect(meta.value.has("t-1")).toBe(false)
  })

  it("retries a track whose load threw, since nothing was cached for it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    catalog.throwsFor.add("t-1")
    catalog.tracks.set("t-1", makeTrack("t-1"))

    const { meta, ids } = mountMetadata(["t-1"])
    await flush()

    catalog.throwsFor.clear()
    ids.value = ["t-1", "t-2"]
    await flush()

    expect(meta.value.get("t-1")?.trackTitle).toBe("Happiness Beyond The Senses")
  })

  it("re-localizes the author on a language switch without loading again", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1", { authorId: "a-1" as AuthorId }))
    catalog.authors.set(
      "a-1",
      makeAuthor({ en: "A.C. Bhaktivedanta Swami", ru: "Бхактиведанта Свами" })
    )

    const { meta, lang } = mountMetadata(["t-1"])
    await flush()

    lang.value = "ru"
    await flush()

    expect(meta.value.get("t-1")?.authorName).toBe("Бхактиведанта Свами")
    expect(catalog.trackLoads).toEqual(["t-1"])
    expect(catalog.authorLoads).toEqual(["a-1"])
  })

  it("titles the track in a library language, not in the UI language", async () => {
    libraryLanguages.value = ["ru"]
    catalog.tracks.set(
      "t-1",
      makeTrack("t-1", {
        variants: [variant("en", "Happiness Beyond The Senses"), variant("ru", "Счастье")],
      })
    )

    const { meta } = mountMetadata(["t-1"], "en")
    await flush()

    expect(meta.value.get("t-1")?.trackTitle).toBe("Счастье")
  })

  it("makes sure the source dictionary is loaded before formatting a reference", async () => {
    catalog.tracks.set("t-1", makeTrack("t-1"))

    mountMetadata(["t-1"])
    await flush()

    expect(dictionaryLoads.count).toBe(1)
  })
})
