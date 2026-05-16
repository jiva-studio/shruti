import { describe, expect, it, vi } from "vitest"
import { deleteNote } from "../deleteNote.js"
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
  meta: null,
  ...over,
})

describe("deleteNote", () => {
  it("deletes an existing note", async () => {
    const del = vi.fn<INoteRepository["delete"]>().mockResolvedValue(undefined)
    const repo = makeRepo({
      getById: async () => sample(),
      delete: del,
    })
    const result = await deleteNote(
      { id: "n-1" as NoteId },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(true)
    expect(del).toHaveBeenCalledWith("n-1")
  })

  it("returns not-found for absent notes", async () => {
    const del = vi.fn<INoteRepository["delete"]>()
    const repo = makeRepo({ getById: async () => null, delete: del })
    const result = await deleteNote(
      { id: "missing" as NoteId },
      { notes: repo, unitOfWork: noopUnitOfWork }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
    expect(del).not.toHaveBeenCalled()
  })
})
