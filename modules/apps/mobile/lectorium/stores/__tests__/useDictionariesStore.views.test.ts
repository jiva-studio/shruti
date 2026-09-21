import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Topic } from "@lib/domain/topic.js"
import type {
  AuthorId,
  LanguageCode,
  LocationId,
  SourceId,
  TagId,
  TopicId,
} from "@lib/domain/core.js"

const authors: Author[] = [
  { id: "a-zoe" as AuthorId, names: new Map([["en", "Zoe"]]) },
  { id: "a-abe" as AuthorId, names: new Map([["en", "Abe"]]) },
  { id: "a-bare" as AuthorId, names: new Map() },
]
const locations: Location[] = [
  { id: "l-b" as LocationId, names: new Map([["en", "Bombay"]]) },
  { id: "l-a" as LocationId, names: new Map([["en", "Amsterdam"]]) },
]
const sources: Source[] = [
  {
    id: "src-sb" as SourceId,
    names: new Map([["en", { fullName: "Srimad Bhagavatam", shortName: "SB" }]]),
  },
  { id: "src-bg" as SourceId, names: new Map() },
]
const tags: Tag[] = [
  { id: "tg-b" as TagId, names: new Map([["en", "Bhakti"]]) },
  { id: "tg-a" as TagId, names: new Map([["en", "Austerity"]]) },
]
const topics: Topic[] = [
  {
    id: "tp-1" as TopicId,
    names: new Map([
      ["ru", "Бхакти"],
      ["en", "Bhakti"],
    ]),
    shortNames: new Map([["ru", "Бх"]]),
    cover: "covers/bhakti.png",
  },
  {
    id: "tp-2" as TopicId,
    names: new Map([["fr", "Amour"]]),
    shortNames: new Map(),
    cover: null,
  },
  { id: "tp-3" as TopicId, names: new Map(), shortNames: new Map(), cover: null },
]
const languages: Language[] = [
  { code: "ru" as LanguageCode, fullName: "Russian", icon: null },
  { code: "en" as LanguageCode, fullName: "English", icon: null },
]

let fail = false
const listYears = vi.fn(async () => [2020, 1975])
const appLanguage = ref<LanguageCode>("en" as LanguageCode)
const libraryLanguages = ref<readonly LanguageCode[]>(["ru"] as LanguageCode[])

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      authors: { listAll: async () => authors },
      languages: { listWithTracks: async () => languages },
      locations: { listAll: async () => locations },
      sources: { listAll: async () => sources },
      tags: { listAll: async () => tags },
      topics: {
        listAll: async () => {
          if (fail) throw new Error("content db missing")
          return topics
        },
      },
      tracks: { listYears },
    }),
  }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => appLanguage }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguages,
}))

import { useDictionariesStore } from "../useDictionariesStore.js"

describe("useDictionariesStore — derived views", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fail = false
    appLanguage.value = "en" as LanguageCode
    libraryLanguages.value = ["ru"] as LanguageCode[]
    listYears.mockClear()
  })

  it("hydrates every dictionary and drops the loading flag", async () => {
    const s = useDictionariesStore()
    expect(s.isLoading).toBe(false)

    await s.ensureLoaded()

    expect(s.authors).toHaveLength(3)
    expect(s.years).toEqual([2020, 1975])
    expect(s.isLoading).toBe(false)
    expect(s.error).toBeNull()
  })

  it("indexes each dictionary by its own key", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.authorsById.get("a-abe" as AuthorId)?.names.get("en")).toBe("Abe")
    expect(s.locationsById.get("l-b" as LocationId)?.names.get("en")).toBe("Bombay")
    expect(s.sourcesById.get("src-sb" as SourceId)?.id).toBe("src-sb")
    expect(s.tagsById.get("tg-a" as TagId)?.names.get("en")).toBe("Austerity")
    expect(s.topicsById.get("tp-1" as TopicId)?.cover).toBe("covers/bhakti.png")
    expect(s.languagesByCode.get("ru" as LanguageCode)?.fullName).toBe("Russian")
  })

  it("names topics in the library content language, not the UI language", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.topicNamesById.get("tp-1")).toBe("Бхакти")
  })

  it("falls back to the first available topic name, then to the raw id", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.topicNamesById.get("tp-2")).toBe("Amour")
    expect(s.topicNamesById.get("tp-3")).toBe("tp-3")
  })

  it("prefers a short topic label and falls back through to the full name", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.topicShortNamesById.get("tp-1")).toBe("Бх")
    expect(s.topicShortNamesById.get("tp-2")).toBe("Amour")
    expect(s.topicShortNamesById.get("tp-3")).toBe("tp-3")
  })

  it("lists topic covers only for topics that have one", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect([...s.topicCoverById]).toEqual([["tp-1", "covers/bhakti.png"]])
  })

  it("re-derives topic labels when the library language changes", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()
    expect(s.topicNamesById.get("tp-1")).toBe("Бхакти")

    libraryLanguages.value = ["en"] as LanguageCode[]

    expect(s.topicNamesById.get("tp-1")).toBe("Bhakti")
  })

  it("sorts each dictionary by its localised name in the UI language", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.authorsSorted.map((a) => a.id)).toEqual(["a-bare", "a-abe", "a-zoe"])
    expect(s.locationsSorted.map((l) => l.id)).toEqual(["l-a", "l-b"])
    expect(s.tagsSorted.map((t) => t.id)).toEqual(["tg-a", "tg-b"])
  })

  it("sorts sources by the localised full name, falling back to the id", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.sourcesSorted.map((x) => x.id)).toEqual(["src-bg", "src-sb"])
  })

  it("sorts topics by the UI language, unlike the content-language labels", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    expect(s.topicNamesById.get("tp-1")).toBe("Бхакти")
    expect(s.topicsSorted.map((t) => t.id)).toEqual(["tp-1", "tp-2", "tp-3"])
  })

  it("re-sorts when the UI language changes", async () => {
    const s = useDictionariesStore()
    await s.ensureLoaded()

    appLanguage.value = "ru" as LanguageCode

    expect(s.topicsSorted.map((t) => t.id)).toEqual(["tp-2", "tp-3", "tp-1"])
  })

  it("surfaces a hydration failure as an error message and stays retryable", async () => {
    fail = true
    const s = useDictionariesStore()

    await s.ensureLoaded()

    expect(s.error).toBe("content db missing")
    expect(s.isLoading).toBe(false)
    expect(s.topics).toEqual([])

    fail = false
    await s.ensureLoaded()

    expect(s.error).toBeNull()
    expect(s.topics).toHaveLength(3)
  })

  it("queries the catalog only once after a successful hydration", async () => {
    const s = useDictionariesStore()

    await s.ensureLoaded()
    await s.ensureLoaded()

    expect(listYears).toHaveBeenCalledOnce()
  })
})
