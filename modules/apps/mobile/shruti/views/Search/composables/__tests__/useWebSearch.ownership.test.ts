import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref, type Ref } from "vue"
import type { DiscoverySearchResponse } from "@lib/contracts"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

const search = vi.fn<() => Promise<DiscoverySearchResponse>>()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ discoveryClient: { search } }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ref("en"),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({ authorsById: new Map(), sourcesById: new Map() }),
}))

const { useWebSearch } = await import("../useWebSearch.js")

function answer(count: number): DiscoverySearchResponse {
  return {
    hits: Array.from({ length: count }, (_, i) => ({ item_id: `hit-${i}` })),
    filter: {},
  } as unknown as DiscoverySearchResponse
}

/** Let the watcher run and the 400 ms typing debounce elapse. */
async function settle(): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(500)
}

function setup(opts: { owned: Ref<boolean> }) {
  const query = ref("krishna")
  const filters = ref({} as FiltersModel)
  const enabled = ref(true)
  const web = useWebSearch({ query, filters, enabled, owned: opts.owned })
  return { query, filters, enabled, web }
}

/**
 * `enabled` and `owned` are two different noes, and #1786 folded them into one.
 * An empty field means there is nothing to show — the lane clears. Being
 * covered by a page pushed on top (the paywall, "see all") means the words
 * still stand: the shelf underneath has to survive being covered, or every add
 * that opens the subscription page wipes the results it was tapped from.
 */
describe("useWebSearch — the page underneath (#1786)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    search.mockReset()
    search.mockResolvedValue(answer(2))
  })

  it("keeps the hits it found while another page owns the field", async () => {
    const owned = ref(true)
    const { web } = setup({ owned })
    await settle()
    expect(web.hits.value).toHaveLength(2)

    owned.value = false
    await settle()

    expect(web.hits.value).toHaveLength(2)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("asks nothing for words typed while it is covered", async () => {
    const owned = ref(true)
    const { query } = setup({ owned })
    await settle()
    search.mockClear()

    owned.value = false
    query.value = "gita"
    await settle()

    expect(search).not.toHaveBeenCalled()
  })

  it("re-asks on return only when the words moved while it was away", async () => {
    const owned = ref(true)
    const { query } = setup({ owned })
    await settle()
    search.mockClear()

    // Covered, and the field comes back exactly as it was left.
    owned.value = false
    query.value = "gita"
    query.value = "krishna"
    await settle()
    owned.value = true
    await settle()
    expect(search).not.toHaveBeenCalled()

    // Covered again, and this time it was retyped up there.
    owned.value = false
    query.value = "gita"
    await settle()
    owned.value = true
    await settle()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("still clears the lane when the field empties", async () => {
    const owned = ref(true)
    const { query, web } = setup({ owned })
    await settle()
    expect(web.hits.value).toHaveLength(2)

    query.value = "   "
    await settle()

    expect(web.hits.value).toHaveLength(0)
  })
})

/**
 * Every archive search is paid for, so "covered" has to mean it before the
 * request goes out, not only at the moment the words change. Typing a word and
 * tapping a result inside the 400ms debounce is ordinary behaviour, and the
 * page that opens searches the same words itself.
 */
describe("useWebSearch — a covered page pays for nothing (#1842)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    search.mockReset()
    search.mockResolvedValue(answer(2))
  })

  it("drops a search that was owed when the page lost the field", async () => {
    const owned = ref(true)
    setup({ owned })
    // Armed by the words already in the field, and not yet fired.
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(search).not.toHaveBeenCalled()

    owned.value = false
    await settle()

    expect(search).not.toHaveBeenCalled()
  })

  it("asks nothing when the filters move while it is covered", async () => {
    const owned = ref(true)
    const { filters } = setup({ owned })
    await settle()
    search.mockClear()

    owned.value = false
    await settle()
    filters.value = { languages: ["en"] } as unknown as FiltersModel
    await settle()

    expect(search).not.toHaveBeenCalled()
  })

  it("still pages for the page that has the field", async () => {
    const owned = ref(true)
    search.mockResolvedValue(answer(20))
    const { web } = setup({ owned })
    await settle()
    expect(web.hasMore.value).toBe(true)

    await web.loadMore()

    expect(search).toHaveBeenCalledTimes(2)
  })
})

/**
 * A search that failed is not an answer, so the words that failed must not
 * count as the ones the shelf is showing. The web lane has no retry button —
 * if the memo survives the failure, "archives unavailable" stands for words
 * that would work until the field is cleared entirely.
 */
describe("useWebSearch — a failed search is not the answer (#1842)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    search.mockReset()
    search.mockResolvedValue(answer(2))
  })

  it("asks again for the words that failed when the page comes back", async () => {
    search.mockRejectedValueOnce(new Error("offline"))
    const owned = ref(true)
    const { web } = setup({ owned })
    await settle()
    expect(web.error.value).not.toBeNull()
    expect(web.hits.value).toHaveLength(0)

    owned.value = false
    await settle()
    owned.value = true
    await settle()

    expect(web.hits.value).toHaveLength(2)
    expect(web.error.value).toBeNull()
  })

  it("answers the next words after a failure", async () => {
    search.mockRejectedValueOnce(new Error("offline"))
    const owned = ref(true)
    const { query, web } = setup({ owned })
    await settle()
    expect(web.error.value).not.toBeNull()

    query.value = "gita"
    await settle()

    expect(web.hits.value).toHaveLength(2)
    expect(web.error.value).toBeNull()
  })
})
