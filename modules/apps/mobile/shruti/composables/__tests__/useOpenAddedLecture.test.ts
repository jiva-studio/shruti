import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

const listAll = vi.fn<() => Promise<readonly LibraryItem[]>>()
const listArchivedIds = vi.fn<() => Promise<ReadonlySet<string>>>()
const impact = vi.fn()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      libraryItems: { listAll },
      libraryMemberships: { listArchivedIds },
    }),
    haptics: { impact },
  }),
}))

vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync: vi.fn() }))

import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"
import { useOpenAddedLecture } from "../useOpenAddedLecture.js"

/** The address both surfaces carry: a search hit's `media_url`, a chat
 *  candidate's `payload.url`. */
const SOURCE_URL = "https://archive.example/talks/0001.mp3"

function makeItem(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "lib-1",
    trackId: "hash-lib-1",
    status: "ready",
    origin: "private",
    titleRaw: "A lecture",
    authorRaw: "Test Speaker",
    locationRaw: null,
    dateRaw: null,
    langHint: "en",
    authorId: null,
    locationId: null,
    date: null,
    lang: null,
    error: null,
    audioKey: null,
    transcriptKey: null,
    variants: [],
    duration: null,
    coverKey: null,
    references: [],
    sourceUrl: SOURCE_URL,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as LibraryItem
}

/** Load the store with one row for that source, then wire the composable. */
async function setup(
  item: LibraryItem | undefined,
  archived: string[] = []
): Promise<ReturnType<typeof useOpenAddedLecture>> {
  listAll.mockResolvedValue(item ? [item] : [])
  listArchivedIds.mockResolvedValue(new Set(archived))
  await useLibraryStore().refresh()
  return useOpenAddedLecture()
}

describe("useOpenAddedLecture", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listAll.mockReset()
    listArchivedIds.mockReset()
    impact.mockReset()
  })

  it("opens an added lecture on the same sheet the library tile opens", async () => {
    const added = await setup(makeItem())
    expect(added.canOpen(SOURCE_URL)).toBe(true)

    added.open(SOURCE_URL)
    expect(useTrackSheetStore().trackId).toBe("hash-lib-1")
    expect(impact).toHaveBeenCalled()
  })

  it("recognises a lecture added from a YouTube address in either spelling", async () => {
    const added = await setup(
      makeItem({ sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
    )
    expect(added.canOpen("https://youtu.be/dQw4w9WgXcQ")).toBe(true)
  })

  it("does not claim a lecture that is still being fetched", async () => {
    const added = await setup(makeItem({ status: "processing", trackId: null }))
    expect(added.canOpen(SOURCE_URL)).toBe(false)

    added.open(SOURCE_URL)
    expect(useTrackSheetStore().trackId).toBeNull()
  })

  it("does not claim a ready row that resolves to no track", async () => {
    const added = await setup(makeItem({ trackId: null }))
    expect(added.canOpen(SOURCE_URL)).toBe(false)

    added.open(SOURCE_URL)
    expect(useTrackSheetStore().trackId).toBeNull()
  })

  it("does not claim a lecture the user removed — that one is offered again", async () => {
    const added = await setup(makeItem(), ["lib-1"])
    expect(added.canOpen(SOURCE_URL)).toBe(false)

    added.open(SOURCE_URL)
    expect(useTrackSheetStore().trackId).toBeNull()
  })

  it("does not claim a candidate nobody has added, or one with no address", async () => {
    const added = await setup(undefined)
    expect(added.canOpen(SOURCE_URL)).toBe(false)
    expect(added.canOpen(undefined)).toBe(false)

    added.open(SOURCE_URL)
    added.open(undefined)
    expect(useTrackSheetStore().trackId).toBeNull()
  })
})
