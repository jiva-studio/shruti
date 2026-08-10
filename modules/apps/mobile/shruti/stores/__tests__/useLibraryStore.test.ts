import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const listAll = vi.fn<() => Promise<readonly LibraryItem[]>>()
const listArchivedIds = vi.fn<() => Promise<ReadonlySet<string>>>()
const submit = vi.fn<() => Promise<{ membership_id: string }>>()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      libraryItems: { listAll },
      libraryMemberships: { listArchivedIds },
    }),
    ingestClient: { submit },
  }),
}))

vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync: vi.fn() }))

vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true }),
}))

vi.mock("@shruti/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen: vi.fn() }),
}))

import { useLibraryStore } from "../useLibraryStore.js"

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

function makeItem(id: string, status: LibraryItem["status"]): LibraryItem {
  return {
    id,
    trackId: status === "ready" ? `hash-${id}` : null,
    status,
    origin: "private",
    titleRaw: `Lecture ${id}`,
    authorRaw: "Some Author",
    locationRaw: null,
    dateRaw: "1972-08-14",
    langHint: "en",
    authorId: null,
    locationId: null,
    date: "1972-08-14",
    lang: null,
    error: null,
    audioKey: null,
    transcriptKey: null,
    variants: [],
    duration: null,
    coverKey: null,
    references: [],
    sourceUrl: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("useLibraryStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listAll.mockReset()
    listArchivedIds.mockReset()
    submit.mockReset()
    listArchivedIds.mockResolvedValue(new Set())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("projects the repository rows and derives pending / empty state", async () => {
    listAll.mockResolvedValue([makeItem("a", "processing"), makeItem("b", "ready")])
    const store = useLibraryStore()

    expect(store.isEmpty).toBe(true) // before load

    await store.refresh()

    expect(store.items).toHaveLength(2)
    expect(store.isEmpty).toBe(false)
    expect(store.hasPending).toBe(true)
    expect(store.pendingItems.map((i) => i.id)).toEqual(["a"])
    expect(store.getById("b")?.status).toBe("ready")
  })

  it("reports no pending when every item is settled", async () => {
    listAll.mockResolvedValue([makeItem("a", "ready"), makeItem("b", "failed")])
    const store = useLibraryStore()
    await store.refresh()
    expect(store.hasPending).toBe(false)
  })

  it("ensureLoaded fetches once, then is a no-op", async () => {
    listAll.mockResolvedValue([makeItem("a", "ready")])
    const store = useLibraryStore()

    await store.ensureLoaded()
    await store.ensureLoaded()

    expect(listAll).toHaveBeenCalledTimes(1)
  })

  it("surfaces a load error and clears the list", async () => {
    listAll.mockRejectedValue(new Error("db closed"))
    const store = useLibraryStore()
    await store.refresh()
    expect(store.error).toBe("db closed")
    expect(store.items).toEqual([])
  })

  // A double-tap on "Add to library" must not put two requests on the wire: the
  // row hasn't synced down yet, so findBySource can't dedup it (issue #1622).
  it("submits once while an add for the same source is in flight", async () => {
    listAll.mockResolvedValue([])
    const pending: Array<(v: { membership_id: string }) => void> = []
    submit.mockImplementation(
      () => new Promise<{ membership_id: string }>((resolve) => pending.push(resolve))
    )
    const store = useLibraryStore()
    await store.refresh()

    // First tap: held on the wire. Second tap: a URL variant of the same video,
    // which findBySource cannot match yet (the row has not synced down).
    const first = store.addByUrl("https://youtu.be/2QezV4DhHVo")
    await vi.waitFor(() => expect(submit).toHaveBeenCalled())
    const second = store.addByUrl("https://www.youtube.com/watch?v=2QezV4DhHVo&t=30")
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(submit).toHaveBeenCalledTimes(1)
    pending.forEach((resolve) => resolve({ membership_id: "run-1" }))
    await Promise.all([first, second])
    expect(store.error).toBeNull()
  })
})
