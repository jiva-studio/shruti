import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository, UpdateNoteInput } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"

const store = new Map<NoteId, Note>()
let listFails: unknown = null

const notes: INoteRepository = {
  async getById(id) {
    return store.get(id) ?? null
  },
  async listByTrack(trackId) {
    return [...store.values()].filter((n) => n.trackId === trackId)
  },
  async listRecent(limit) {
    if (listFails) throw listFails
    return [...store.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  },
  async create(input) {
    const note: Note = {
      id: input.id ?? (`n-${store.size}` as NoteId),
      trackId: input.trackId,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      createdAt: 0,
      meta: input.meta ?? null,
    }
    store.set(note.id, note)
    return note
  },
  async update(input: UpdateNoteInput) {
    const existing = store.get(input.id)
    if (!existing) throw new Error("not found")
    const next: Note = {
      ...existing,
      text: input.text ?? existing.text,
      timeStart: input.timeStart ?? existing.timeStart,
      timeEnd: input.timeEnd ?? existing.timeEnd,
      meta: input.meta === undefined ? existing.meta : input.meta,
    }
    store.set(next.id, next)
    return next
  },
  async delete(id) {
    store.delete(id)
  },
  async clearAll() {
    store.clear()
  },
}

const unitOfWork: IUnitOfWork = { run: async (fn) => fn(undefined) }

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ repositories: () => ({ notes, unitOfWork }) }),
}))

import { onSyncEvent } from "@lectorium/services/syncEvents.js"
import { useNotesStore } from "../useNotesStore.js"

function seed(count: number, prefix = "n"): void {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}` as NoteId
    store.set(id, {
      id,
      trackId: "t-1" as TrackId,
      text: `note ${i}`,
      timeStart: 0,
      timeEnd: 1_000,
      createdAt: 10_000 - i,
      meta: null,
    })
  }
}

describe("useNotesStore — paging", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.clear()
    listFails = null
  })

  it("renders one page and reports that more are waiting", async () => {
    seed(120)
    const notesStore = useNotesStore()

    await notesStore.refresh()

    expect(notesStore.rendered).toHaveLength(50)
    expect(notesStore.filtered).toHaveLength(120)
    expect(notesStore.hasMore).toBe(true)
  })

  it("pages in the rest and stops at the end", async () => {
    seed(120)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    notesStore.loadMore()
    expect(notesStore.rendered).toHaveLength(100)

    notesStore.loadMore()
    expect(notesStore.rendered).toHaveLength(120)
    expect(notesStore.hasMore).toBe(false)

    notesStore.loadMore()
    expect(notesStore.rendered).toHaveLength(120)
  })

  it("keeps the scrolled-open window across a refresh", async () => {
    seed(120)
    const notesStore = useNotesStore()
    await notesStore.refresh()
    notesStore.loadMore()

    await notesStore.refresh()

    expect(notesStore.rendered).toHaveLength(100)
  })
})

describe("useNotesStore — a failed load", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.clear()
    listFails = null
  })

  it("empties the list and states the reason", async () => {
    seed(3)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    listFails = new Error("db closed")
    await notesStore.refresh()

    expect(notesStore.all).toEqual([])
    expect(notesStore.rendered).toEqual([])
    expect(notesStore.error).toBe("db closed")
    expect(notesStore.isLoading).toBe(false)
  })

  it("states a generic reason when the failure is not an Error", async () => {
    const notesStore = useNotesStore()
    listFails = "db closed"

    await notesStore.refresh()

    expect(notesStore.error).toBe("Failed to load notes")
  })

  it("clears a previous error on the next good load", async () => {
    const notesStore = useNotesStore()
    listFails = new Error("db closed")
    await notesStore.refresh()

    listFails = null
    seed(1)
    await notesStore.refresh()

    expect(notesStore.error).toBeNull()
    expect(notesStore.rendered).toHaveLength(1)
  })
})

describe("useNotesStore — remove", () => {
  let syncRequests: number
  let unsubscribe: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    store.clear()
    listFails = null
    syncRequests = 0
    unsubscribe = onSyncEvent("sync-requested", () => {
      syncRequests += 1
    })
  })

  afterEach(() => unsubscribe())

  it("drops the note from the rendered list and asks for a sync", async () => {
    seed(3)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    const result = await notesStore.remove("n1" as NoteId)

    expect(result.ok).toBe(true)
    expect(notesStore.rendered.map((n) => n.id)).toEqual(["n0", "n2"])
    expect(syncRequests).toBe(1)
  })

  it("reports a missing note and leaves the list and sync alone", async () => {
    seed(1)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    const result = await notesStore.remove("ghost" as NoteId)

    expect(result).toEqual({ ok: false, error: "not-found" })
    expect(notesStore.rendered).toHaveLength(1)
    expect(syncRequests).toBe(0)
  })
})

describe("useNotesStore — update", () => {
  let syncRequests: number
  let unsubscribe: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    store.clear()
    listFails = null
    syncRequests = 0
    unsubscribe = onSyncEvent("sync-requested", () => {
      syncRequests += 1
    })
  })

  afterEach(() => unsubscribe())

  it("writes the new text through to the rendered list", async () => {
    seed(2)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    const result = await notesStore.update({ id: "n0" as NoteId, text: "edited" })

    expect(result.ok).toBe(true)
    expect(notesStore.rendered.find((n) => n.id === "n0")?.text).toBe("edited")
    expect(syncRequests).toBe(1)
  })

  it("rejects an empty edit without touching the list or the sync", async () => {
    seed(1)
    const notesStore = useNotesStore()
    await notesStore.refresh()

    const result = await notesStore.update({ id: "n0" as NoteId, text: "   " })

    expect(result).toEqual({ ok: false, error: "empty-text" })
    expect(notesStore.rendered[0].text).toBe("note 0")
    expect(syncRequests).toBe(0)
  })

  it("reports a missing note", async () => {
    const notesStore = useNotesStore()
    await notesStore.refresh()

    expect(await notesStore.update({ id: "ghost" as NoteId, text: "x" })).toEqual({
      ok: false,
      error: "not-found",
    })
  })

  it("re-applies the active search after an edit", async () => {
    seed(3)
    const notesStore = useNotesStore()
    await notesStore.refresh()
    await notesStore.setQuery("")
    notesStore.query = "note 1"

    await notesStore.update({ id: "n0" as NoteId, text: "edited" })

    expect(notesStore.appliedQuery).toBe("note 1")
    expect(notesStore.filtered.map((n) => n.id)).toEqual(["n1"])
  })
})
