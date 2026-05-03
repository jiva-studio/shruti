import { describe, expect, it, vi } from "vitest"
import { createNote } from "../createNote.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

function makeRepo(overrides: Partial<INoteRepository> = {}): INoteRepository {
  return {
    getById: async () => null,
    listByTrack: async () => [],
    listRecent: async () => [],
    create: async () => {
      throw new Error("create not stubbed")
    },
    update: async () => {
      throw new Error("update not stubbed")
    },
    delete: async () => {},
    clearAll: async () => {},
    ...overrides,
  }
}

const created: Note = {
  id: "n-new" as NoteId,
  trackId: "t-1" as TrackId,
  text: "kept",
  timeStart: 5,
  timeEnd: 10,
  createdAt: 1000,
}

describe("createNote", () => {
  it("trims text and forwards it to the repository", async () => {
    const create = vi.fn<INoteRepository["create"]>().mockResolvedValue(created)
    const repo = makeRepo({ create })
    const result = await createNote(
      { trackId: "t-1" as TrackId, text: "  kept  ", timeStart: 5, timeEnd: 10 },
      { notes: repo }
    )
    expect(result.ok).toBe(true)
    expect(create).toHaveBeenCalledWith({
      trackId: "t-1",
      text: "kept",
      timeStart: 5,
      timeEnd: 10,
    })
  })

  it("rejects empty / whitespace-only text", async () => {
    const create = vi.fn<INoteRepository["create"]>()
    const repo = makeRepo({ create })
    const result = await createNote(
      { trackId: "t-1" as TrackId, text: "   ", timeStart: 0, timeEnd: 0 },
      { notes: repo }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("empty-text")
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects text longer than 4000 chars", async () => {
    const repo = makeRepo()
    const result = await createNote(
      { trackId: "t-1" as TrackId, text: "x".repeat(4001), timeStart: 0, timeEnd: 0 },
      { notes: repo }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("text-too-long")
  })

  it("rejects negative timeStart and inverted ranges", async () => {
    const repo = makeRepo()
    const neg = await createNote(
      { trackId: "t-1" as TrackId, text: "ok", timeStart: -1, timeEnd: 5 },
      { notes: repo }
    )
    expect(neg.ok).toBe(false)
    if (!neg.ok) expect(neg.error).toBe("invalid-timestamps")

    const inv = await createNote(
      { trackId: "t-1" as TrackId, text: "ok", timeStart: 10, timeEnd: 5 },
      { notes: repo }
    )
    expect(inv.ok).toBe(false)
    if (!inv.ok) expect(inv.error).toBe("invalid-timestamps")
  })

  it("rejects NaN / Infinity timestamps", async () => {
    const repo = makeRepo()
    for (const [start, end] of [
      [Number.NaN, 5],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 5],
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 5],
    ] as const) {
      const r = await createNote(
        { trackId: "t-1" as TrackId, text: "ok", timeStart: start, timeEnd: end },
        { notes: repo }
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("invalid-timestamps")
    }
  })
})
