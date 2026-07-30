import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const listAll = vi.fn<() => Promise<readonly LibraryItem[]>>()
const requestSync = vi.fn()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ libraryItems: { listAll } }),
  }),
}))

vi.mock("@shruti/services/syncEvents.js", () => ({
  requestSync: (...args: unknown[]) => requestSync(...args),
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
    datePrecision: "day",
    lang: null,
    langConfidence: null,
    error: null,
    audioKey: null,
    transcriptKey: null,
    duration: null,
    coverKey: null,
    references: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("useLibraryStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listAll.mockReset()
    requestSync.mockReset()
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

  it("retry() nudges the sync poller then re-pulls the projection", async () => {
    listAll.mockResolvedValue([makeItem("a", "failed")])
    const store = useLibraryStore()
    await store.refresh()

    listAll.mockClear()
    listAll.mockResolvedValue([makeItem("a", "processing")])
    await store.retry()

    expect(requestSync).toHaveBeenCalledTimes(1)
    expect(listAll).toHaveBeenCalledTimes(1)
    expect(store.hasPending).toBe(true)
  })
})
