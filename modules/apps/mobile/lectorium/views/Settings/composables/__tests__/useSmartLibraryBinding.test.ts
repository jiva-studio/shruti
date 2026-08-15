// @vitest-environment jsdom
import { createApp, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SearchFilterSectionDef } from "@ui/features/tracks/search/filters/index.js"

/**
 * The Smart Library filter binding is what stands between the search-filters
 * sheet and the persisted auto-download filters. Every dimension the sheet
 * offers has to survive the round trip — be hydrated in, written back, counted
 * (the sheet's Reset button is driven by that count) and cleared by reset.
 *
 * Topics were offered by the sheet and dropped by all four (#1585): the
 * summary read the local ref, so the user got confirmation, while nothing was
 * saved and nothing was filtered.
 */

interface FakeStore {
  authorIds: Ref<readonly string[]>
  languageCodes: Ref<readonly string[]>
  locationIds: Ref<readonly string[]>
  sourceIds: Ref<readonly string[]>
  tagIds: Ref<readonly string[]>
  topicIds: Ref<readonly string[]>
  duration: Ref<readonly string[]>
  sort: Ref<string | undefined>
  dateFrom: Ref<string | undefined>
  dateTo: Ref<string | undefined>
  load: () => Promise<void>
  setTopics: (ids: readonly string[]) => Promise<void>
  [key: string]: unknown
}

let store: FakeStore

/** Mirrors the persisted store's surface, minus Pinia and the preferences IO. */
function makeStore(seed: { topicIds?: readonly string[] } = {}): FakeStore {
  const s: Partial<FakeStore> = {
    authorIds: ref<readonly string[]>([]),
    languageCodes: ref<readonly string[]>([]),
    locationIds: ref<readonly string[]>([]),
    sourceIds: ref<readonly string[]>([]),
    tagIds: ref<readonly string[]>([]),
    topicIds: ref<readonly string[]>(seed.topicIds ?? []),
    duration: ref<readonly string[]>([]),
    sort: ref<string | undefined>(undefined),
    dateFrom: ref<string | undefined>(undefined),
    dateTo: ref<string | undefined>(undefined),
    load: vi.fn(async () => {}),
  }
  const setter =
    (key: keyof FakeStore) =>
    async (value: unknown): Promise<void> => {
      ;(s[key] as Ref<unknown>).value = value
    }
  s.setAuthors = vi.fn(setter("authorIds"))
  s.setLanguages = setter("languageCodes")
  s.setLocations = setter("locationIds")
  s.setSources = setter("sourceIds")
  s.setTags = setter("tagIds")
  s.setTopics = vi.fn(setter("topicIds"))
  s.setDuration = setter("duration")
  s.setSort = setter("sort")
  s.setDateFrom = setter("dateFrom")
  s.setDateTo = setter("dateTo")
  s.clearAll = async (): Promise<void> => {
    ;(s.authorIds as Ref<readonly string[]>).value = []
    ;(s.languageCodes as Ref<readonly string[]>).value = []
    ;(s.locationIds as Ref<readonly string[]>).value = []
    ;(s.sourceIds as Ref<readonly string[]>).value = []
    ;(s.tagIds as Ref<readonly string[]>).value = []
    ;(s.topicIds as Ref<readonly string[]>).value = []
    ;(s.duration as Ref<readonly string[]>).value = []
    ;(s.sort as Ref<string | undefined>).value = undefined
    ;(s.dateFrom as Ref<string | undefined>).value = undefined
    ;(s.dateTo as Ref<string | undefined>).value = undefined
  }
  // The composable reads `store.topicIds` etc. as plain values (Pinia unwraps
  // refs on the store proxy); expose the same via getters.
  return new Proxy(s as FakeStore, {
    get(target, key: string) {
      const value = target[key]
      return value !== null && typeof value === "object" && "value" in (value as object)
        ? (value as Ref<unknown>).value
        : value
    },
  })
}

const TOPIC_SECTION: SearchFilterSectionDef = {
  kind: "multi",
  key: "topics",
  model: "topics",
  title: "Topics",
  icon: {},
  items: [
    { id: "topic-a", title: "Bhakti" },
    { id: "topic-b", title: "Renunciation" },
  ],
} as SearchFilterSectionDef

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@lectorium/stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => store,
}))
vi.mock("@lectorium/views/Search/composables/useSearchFilterSections.js", () => ({
  useSearchFilterSections: () => ({ sections: ref([TOPIC_SECTION]) }),
}))

import {
  useSmartLibraryBinding,
  type UseSmartLibraryBindingReturn,
} from "../useSmartLibraryBinding.js"

function mountBinding(): {
  app: ReturnType<typeof createApp>
  binding: UseSmartLibraryBindingReturn
} {
  let binding!: UseSmartLibraryBindingReturn
  const app = createApp({
    setup() {
      binding = useSmartLibraryBinding(ref(3600), ref("off"), ref(true))
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return { app, binding }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  store = makeStore()
})

describe("useSmartLibraryBinding — topics", () => {
  it("hydrates the persisted topics into the sheet's model", async () => {
    store = makeStore({ topicIds: ["topic-a"] })
    const { app, binding } = mountBinding()
    await flush()

    expect(binding.filters.value.topics).toEqual(["topic-a"])
    app.unmount()
  })

  it("persists a topic the user picks", async () => {
    const { app, binding } = mountBinding()
    await flush()

    binding.filters.value = { ...binding.filters.value, topics: ["topic-b"] }
    await flush()

    expect(store.setTopics).toHaveBeenCalledWith(["topic-b"])
    expect(store.topicIds).toEqual(["topic-b"])
    app.unmount()
  })

  it("counts topics, so the sheet's Reset button is not left disabled", async () => {
    const { app, binding } = mountBinding()
    await flush()
    expect(binding.activeFilterCount.value).toBe(0)

    binding.filters.value = { ...binding.filters.value, topics: ["topic-a", "topic-b"] }
    await flush()

    expect(binding.activeFilterCount.value).toBe(2)
    app.unmount()
  })

  it("clears topics on reset, in the model and in the store", async () => {
    store = makeStore({ topicIds: ["topic-a"] })
    const { app, binding } = mountBinding()
    await flush()

    await binding.reset()
    await flush()

    expect(binding.filters.value.topics).toEqual([])
    expect(store.topicIds).toEqual([])
    app.unmount()
  })

  it("only summarises a topic once it is actually stored", async () => {
    const { app, binding } = mountBinding()
    await flush()
    expect(binding.filterSummary.value).toBe("")

    binding.filters.value = { ...binding.filters.value, topics: ["topic-a"] }
    await flush()

    expect(binding.filterSummary.value).toContain("Bhakti")
    expect(store.topicIds).toEqual(["topic-a"])
    app.unmount()
  })
})

/**
 * Issue #1853: the binding used to hold a private ref hydrated once, and its
 * deep watcher wrote all ten dimensions back on any change. Settings and the
 * Library landing each hold an instance and Ionic keeps both mounted for the
 * app's lifetime, so an edit through the stale one erased what the other had
 * persisted — the filters that decide what the device downloads.
 */
describe("useSmartLibraryBinding — two bindings over one store", () => {
  it("shows one binding what the other persisted", async () => {
    const a = mountBinding()
    const b = mountBinding()
    await flush()

    b.binding.filters.value = { ...b.binding.filters.value, authors: ["author-1", "author-2"] }
    await flush()

    expect(a.binding.filters.value.authors).toEqual(["author-1", "author-2"])
    a.app.unmount()
    b.app.unmount()
  })

  it("does not erase the other binding's dimensions when edited", async () => {
    // A is created first, so under the old snapshot binding it never saw B's
    // authors and its next write reinstated its own empty copy of them.
    const a = mountBinding()
    const b = mountBinding()
    await flush()

    b.binding.filters.value = { ...b.binding.filters.value, authors: ["author-1"] }
    await flush()
    a.binding.filters.value = { ...a.binding.filters.value, topics: ["topic-a"] }
    await flush()

    expect(store.authorIds).toEqual(["author-1"])
    expect(store.topicIds).toEqual(["topic-a"])
    expect(b.binding.filters.value.topics).toEqual(["topic-a"])
    a.app.unmount()
    b.app.unmount()
  })

  it("writes only the dimension that changed", async () => {
    const { app, binding } = mountBinding()
    await flush()

    binding.filters.value = { ...binding.filters.value, topics: ["topic-b"] }
    await flush()

    expect(store.setTopics).toHaveBeenCalledTimes(1)
    // The untouched nine are not restated, so they cannot be restated wrongly.
    expect(store.setAuthors).not.toHaveBeenCalled()
    app.unmount()
  })

  it("re-reads a write that bypassed the bindings (chat's proactive apply)", async () => {
    const { app, binding } = mountBinding()
    await flush()

    // `applyProactiveSmartLibrary` sets the store directly, never the binding.
    await (store.setTags as (ids: readonly string[]) => Promise<void>)(["tag-1"])
    await flush()

    expect(binding.filters.value.tags).toEqual(["tag-1"])
    app.unmount()
  })

  it("clears every dimension on reset, for both bindings", async () => {
    store = makeStore({ topicIds: ["topic-a"] })
    const a = mountBinding()
    const b = mountBinding()
    await flush()
    b.binding.filters.value = { ...b.binding.filters.value, authors: ["author-1"] }
    await flush()

    await a.binding.reset()
    await flush()

    expect(store.authorIds).toEqual([])
    expect(store.topicIds).toEqual([])
    expect(b.binding.filters.value.authors).toEqual([])
    a.app.unmount()
    b.app.unmount()
  })
})
