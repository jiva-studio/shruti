import { describe, expect, it, vi } from "vitest"
import { updateNote } from "../updateNote.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

const noopUnitOfWork: IUnitOfWork = { run: async (fn) => fn() }

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

const sample = (over: Partial<Note> = {}): Note => ({
  id: "n-1" as NoteId,
  trackId: "t-1" as TrackId,
  text: "hello",
  timeStart: 0,
  timeEnd: 0,
  createdAt: 1000,
  ...over,
})

describe("updateNote", () => {
  it("updates an existing note and forwards only the provided fields", async () => {
    const updateSpy = vi.fn<INoteRepository["update"]>().mockImplementation(async (input) => ({
      ...sample(),
      text: input.text ?? sample().text,
    }))
    const repo = makeRepo({
      getById: async () => sample(),
      update: updateSpy,
    })
    const result = await updateNote(
      { id: "n-1" as NoteId, text: "new text" },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.text).toBe("new text")
    expect(updateSpy).toHaveBeenCalledWith({
      id: "n-1",
      text: "new text",
      timeStart: undefined,
      timeEnd: undefined,
    })
  })

  it("returns not-found when the note is absent", async () => {
    const repo = makeRepo({ getById: async () => null })
    const result = await updateNote(
      { id: "missing" as NoteId, text: "x" },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })

  it("rejects empty/whitespace-only text", async () => {
    const updateSpy = vi.fn<INoteRepository["update"]>()
    const repo = makeRepo({ getById: async () => sample(), update: updateSpy })
    const result = await updateNote(
      { id: "n-1" as NoteId, text: "   " },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("empty-text")
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("rejects inverted time ranges", async () => {
    const updateSpy = vi.fn<INoteRepository["update"]>()
    const repo = makeRepo({ getById: async () => sample(), update: updateSpy })
    const result = await updateNote(
      { id: "n-1" as NoteId, timeStart: 10, timeEnd: 5 },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("invalid-range")
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("rejects partial timeStart that becomes greater than the existing timeEnd", async () => {
    const updateSpy = vi.fn<INoteRepository["update"]>()
    const repo = makeRepo({
      getById: async () => sample({ timeStart: 0, timeEnd: 100 }),
      update: updateSpy,
    })
    const result = await updateNote(
      { id: "n-1" as NoteId, timeStart: 150 },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("invalid-range")
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("rejects partial timeEnd that becomes smaller than the existing timeStart", async () => {
    const updateSpy = vi.fn<INoteRepository["update"]>()
    const repo = makeRepo({
      getById: async () => sample({ timeStart: 50, timeEnd: 100 }),
      update: updateSpy,
    })
    const result = await updateNote(
      { id: "n-1" as NoteId, timeEnd: 10 },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("invalid-range")
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
