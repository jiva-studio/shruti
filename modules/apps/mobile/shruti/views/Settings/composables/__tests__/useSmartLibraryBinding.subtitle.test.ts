// @vitest-environment jsdom
/**
 * The Smart Library row's subtitle is the only place the user is told what the
 * feature will download and when it will clean up — and the dimensions beyond
 * the six id lists (length, sort, date range) have to survive the same round
 * trip through the persisted store.
 */
import { createApp, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SearchFilterSectionDef } from "@ui/features/tracks/search/filters/index.js"
import type { AutoArchiveDelay } from "@shruti/composables/useAutoArchiveSweep.js"

interface FakeStore {
  [key: string]: unknown
}

let store: FakeStore

function makeStore(): FakeStore {
  const s: Record<string, unknown> = {
    authorIds: ref<readonly string[]>([]),
    languageCodes: ref<readonly string[]>([]),
    locationIds: ref<readonly string[]>([]),
    sourceIds: ref<readonly string[]>([]),
    tagIds: ref<readonly string[]>([]),
    topicIds: ref<readonly string[]>([]),
    duration: ref<readonly string[]>([]),
    sort: ref<string | undefined>(undefined),
    dateFrom: ref<string | undefined>(undefined),
    dateTo: ref<string | undefined>(undefined),
    load: async () => {},
  }
  const setter =
    (key: string) =>
    async (value: unknown): Promise<void> => {
      ;(s[key] as Ref<unknown>).value = value
    }
  s.setAuthors = setter("authorIds")
  s.setLanguages = setter("languageCodes")
  s.setLocations = setter("locationIds")
  s.setSources = setter("sourceIds")
  s.setTags = setter("tagIds")
  s.setTopics = setter("topicIds")
  s.setDuration = setter("duration")
  s.setSort = setter("sort")
  s.setDateFrom = setter("dateFrom")
  s.setDateTo = setter("dateTo")
  s.clearAll = async (): Promise<void> => {}
  // Pinia unwraps refs on the store proxy; the composable reads plain values.
  return new Proxy(s, {
    get(target, key: string) {
      const value = target[key]
      return value !== null && typeof value === "object" && "value" in (value as object)
        ? (value as Ref<unknown>).value
        : value
    },
  })
}

const DURATION_SECTION: SearchFilterSectionDef = {
  kind: "single",
  key: "duration",
  model: "duration",
  title: "Length",
  icon: {},
  items: [
    { id: "short", title: "Under 30 minutes" },
    { id: "long", title: "Over an hour" },
  ],
} as SearchFilterSectionDef

const SORT_SECTION: SearchFilterSectionDef = {
  kind: "single",
  key: "sort",
  model: "sort",
  title: "Order",
  icon: {},
  items: [{ id: "newest", title: "Newest first" }],
} as SearchFilterSectionDef

/** The shipped English strings, so the assertions read as the user's row does. */
const MESSAGES: Record<string, string> = {
  "settings.smartLibrary.subtitleOff": "Auto-update lectures and clean up after listening",
  "settings.smartLibrary.subtitleArchivePrefix": "archive",
  "settings.smartLibrary.target.off": "Off",
  "settings.smartLibrary.target.30m": "30 minutes",
  "settings.smartLibrary.target.1h": "1 hour",
  "settings.smartLibrary.target.10h": "10 hours",
  "settings.smartLibrary.archive.immediate": "Immediately",
  "settings.smartLibrary.archive._1d": "After 1 day",
  "settings.smartLibrary.archive._8h": "After 8 hours",
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => MESSAGES[key] ?? key }),
}))
vi.mock("@shruti/stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => store,
}))
vi.mock("@shruti/views/Search/composables/useSearchFilterSections.js", () => ({
  useSearchFilterSections: () => ({ sections: ref([DURATION_SECTION, SORT_SECTION]) }),
}))

import {
  useSmartLibraryBinding,
  type UseSmartLibraryBindingReturn,
} from "../useSmartLibraryBinding.js"

interface Mounted {
  readonly app: ReturnType<typeof createApp>
  readonly binding: UseSmartLibraryBindingReturn
}

function mountBinding(
  targetSeconds = 3600,
  archiveDelay: AutoArchiveDelay = "off",
  isSubscribed = true
): Mounted {
  let binding!: UseSmartLibraryBindingReturn
  const app = createApp({
    setup() {
      binding = useSmartLibraryBinding(ref(targetSeconds), ref(archiveDelay), ref(isSubscribed))
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

describe("useSmartLibraryBinding — the row subtitle", () => {
  it("invites the user in when the feature is switched off", async () => {
    const { app, binding } = mountBinding(0)
    await flush()

    expect(binding.subtitle.value).toBe("Auto-update lectures and clean up after listening")
    app.unmount()
  })

  it("says the same to a user without a subscription, whatever is configured", async () => {
    const { app, binding } = mountBinding(3600, "1d", false)
    await flush()

    expect(binding.subtitle.value).toBe("Auto-update lectures and clean up after listening")
    app.unmount()
  })

  it("names the queue length that is set", async () => {
    const { app, binding } = mountBinding(30 * 60)
    await flush()

    expect(binding.subtitle.value).toBe("30 minutes")
    app.unmount()
  })

  it("falls back to the off label for a length no preset covers", async () => {
    const { app, binding } = mountBinding(45 * 60)
    await flush()

    expect(binding.subtitle.value).toBe("Off")
    app.unmount()
  })

  it("adds the archive delay, lower-cased, behind the queue length", async () => {
    const { app, binding } = mountBinding(10 * 60 * 60, "1d")
    await flush()

    expect(binding.subtitle.value).toBe("10 hours · archive after 1 day")
    app.unmount()
  })

  it("spells out an immediate archive the same way", async () => {
    const { app, binding } = mountBinding(3600, "immediate")
    await flush()

    expect(binding.subtitle.value).toBe("1 hour · archive immediately")
    app.unmount()
  })

  it("says nothing about archiving when it is never done", async () => {
    const { app, binding } = mountBinding(3600, "off")
    await flush()

    expect(binding.subtitle.value).toBe("1 hour")
    app.unmount()
  })

  it("lists the filter between the length and the archive delay", async () => {
    const { app, binding } = mountBinding(3600, "8h")
    await flush()

    binding.filters.value = { ...binding.filters.value, duration: "long" }
    await flush()

    expect(binding.subtitle.value).toBe("1 hour · Over an hour · archive after 8 hours")
    app.unmount()
  })
})

describe("useSmartLibraryBinding — the dimensions beyond the id lists", () => {
  it("persists the length the user picked and reads it back", async () => {
    const { app, binding } = mountBinding()
    await flush()

    binding.filters.value = { ...binding.filters.value, duration: "short" }
    await flush()

    expect(store.duration).toEqual(["short"])
    expect(binding.filters.value.duration).toBe("short")
    expect(binding.activeFilterCount.value).toBe(1)
    app.unmount()
  })

  it("clears the length again when the user drops it", async () => {
    const { app, binding } = mountBinding()
    await flush()
    binding.filters.value = { ...binding.filters.value, duration: "short" }
    await flush()

    binding.filters.value = { ...binding.filters.value, duration: undefined }
    await flush()

    expect(store.duration).toEqual([])
    expect(binding.filters.value.duration).toBeUndefined()
    app.unmount()
  })

  it("persists the sort order", async () => {
    const { app, binding } = mountBinding()
    await flush()

    binding.filters.value = { ...binding.filters.value, sort: "newest" }
    await flush()

    expect(store.sort).toBe("newest")
    expect(binding.filterSummary.value).toBe("Newest first")
    app.unmount()
  })

  it("persists both edges of the date range and counts them as one filter", async () => {
    const { app, binding } = mountBinding()
    await flush()

    binding.filters.value = { ...binding.filters.value, dateFrom: "1972", dateTo: "1975-06" }
    await flush()

    expect(store.dateFrom).toBe("1972")
    expect(store.dateTo).toBe("1975-06")
    expect(binding.activeFilterCount.value).toBe(1)
    app.unmount()
  })

  it("summarises nothing for a section the user never touched", async () => {
    const { app, binding } = mountBinding()
    await flush()

    expect(binding.filterSummary.value).toBe("")
    expect(binding.activeFilterCount.value).toBe(0)
    app.unmount()
  })
})
