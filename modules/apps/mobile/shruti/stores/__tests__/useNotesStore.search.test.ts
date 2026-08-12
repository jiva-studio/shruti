import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const listRecent = vi.fn<(limit: number) => Promise<readonly Note[]>>()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ notes: { listRecent } }),
  }),
}))

import { useNotesStore } from "../useNotesStore.js"

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

function mk(id: string, text: string): Note {
  return {
    id: id as NoteId,
    trackId: "t-1" as TrackId,
    text,
    timeStart: 0,
    timeEnd: 0,
    createdAt: 1000,
    meta: null,
  }
}

const CORPUS: readonly Note[] = [
  mk("1", "Needle in the haystack"),
  mk("2", "Кришна говорит"),
  mk("3", "nothing to see"),
]

/** Keystrokes of someone typing `word`, one prefix per key. */
function keystrokes(word: string): readonly string[] {
  return Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1))
}

describe("useNotesStore search", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    listRecent.mockReset()
    listRecent.mockImplementation(async (limit: number) => CORPUS.slice(0, limit))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("does not hit the repository again while typing", async () => {
    const store = useNotesStore()
    await store.refresh()
    expect(listRecent).toHaveBeenCalledTimes(1)

    const typed = keystrokes("needle")
    for (const q of typed) void store.setQuery(q)
    await vi.advanceTimersByTimeAsync(500)

    expect(typed).toHaveLength(6)
    expect(listRecent).toHaveBeenCalledTimes(1)
  })

  it("settles on the results of the final query", async () => {
    const store = useNotesStore()
    await store.refresh()

    for (const q of keystrokes("needle")) void store.setQuery(q)
    // Mid-flight: the debounce has not fired, the list is untouched.
    expect(store.filtered.map((n) => n.id)).toEqual(["1", "2", "3"])

    await vi.advanceTimersByTimeAsync(500)
    expect(store.query).toBe("needle")
    expect(store.filtered.map((n) => n.id)).toEqual(["1"])
  })

  it("does not advertise the new query against the old result set", async () => {
    const store = useNotesStore()
    await store.refresh()

    void store.setQuery("need")
    // The field is already showing "need", but `filtered` is still the
    // unfiltered list — highlighting must key off the applied query, not the
    // live one, or the previous rows get marked against the newer text.
    expect(store.query).toBe("need")
    expect(store.appliedQuery).toBe("")

    await vi.advanceTimersByTimeAsync(500)
    expect(store.appliedQuery).toBe("need")
  })

  it("keeps the case-insensitive match semantics, Cyrillic included", async () => {
    const store = useNotesStore()
    await store.refresh()

    // Fire-and-forget: a non-empty query resolves only once the debounce
    // fires, so awaiting it before advancing the fake clock would deadlock.
    void store.setQuery("кришна")
    await vi.advanceTimersByTimeAsync(500)
    expect(store.filtered.map((n) => n.id)).toEqual(["2"])
  })

  it("resets immediately when the field is cleared — no debounce wait", async () => {
    const store = useNotesStore()
    await store.refresh()
    void store.setQuery("needle")
    await vi.advanceTimersByTimeAsync(500)
    expect(store.filtered).toHaveLength(1)

    // No timer advance here: clearing must land on the same tick.
    await store.setQuery("")
    expect(store.filtered.map((n) => n.id)).toEqual(["1", "2", "3"])
  })

  it("searches the whole corpus, not just the rendered window", async () => {
    const many = [
      ...Array.from({ length: 400 }, (_, i) => mk(`f${i}`, `filler ${i}`)),
      mk("old", "needle in an old note"),
    ]
    listRecent.mockImplementation(async (limit: number) => many.slice(0, limit))

    const store = useNotesStore()
    await store.refresh()
    void store.setQuery("needle")
    await vi.advanceTimersByTimeAsync(500)

    expect(store.filtered.map((n) => n.id)).toEqual(["old"])
  })

  it("keeps a hit past the 500th note addressable — `all` and `filtered` agree", async () => {
    // The old store loaded `all` from listRecent(500) while search scanned the
    // full corpus, so a hit beyond the 500 newest rendered and was tappable
    // but resolved to null in the view's `currentNote()` — share and delete
    // silently no-opped on it. Needs >500 filler to reproduce.
    const many = [
      ...Array.from({ length: 600 }, (_, i) => mk(`f${i}`, `filler ${i}`)),
      mk("old", "needle in a very old note"),
    ]
    listRecent.mockImplementation(async (limit: number) => many.slice(0, limit))

    const store = useNotesStore()
    await store.refresh()
    void store.setQuery("needle")
    await vi.advanceTimersByTimeAsync(500)

    expect(store.filtered.map((n) => n.id)).toEqual(["old"])
    const hit = store.filtered[0]!
    expect(store.all.find((n) => n.id === hit.id)).toBeDefined()
  })
})

describe("useNotesStore read failure", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listRecent.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports the failure instead of an empty corpus", async () => {
    listRecent.mockRejectedValue(new Error("database is locked"))

    const store = useNotesStore()
    await store.refresh()

    // Both lists are emptied by the catch, so `all.length === 0` alone cannot
    // tell a broken read from a user who has written nothing — the view has to
    // read `error` first or it shows the onboarding copy on a failure.
    expect(store.all).toHaveLength(0)
    expect(store.filtered).toHaveLength(0)
    expect(store.isLoading).toBe(false)
    expect(store.error).toBe("database is locked")
  })

  it("clears the previous error once the read succeeds", async () => {
    listRecent.mockRejectedValueOnce(new Error("database is locked"))
    const store = useNotesStore()
    await store.refresh()
    expect(store.error).not.toBeNull()

    listRecent.mockResolvedValueOnce(CORPUS)
    await store.refresh()

    expect(store.error).toBeNull()
    expect(store.filtered.map((n) => n.id)).toEqual(["1", "2", "3"])
  })
})
