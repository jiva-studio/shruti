import { describe, expect, it } from "vitest"
import { searchNotes } from "../searchNotes.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

function makeRepo(notes: readonly Note[]): INoteRepository {
  return {
    getById: async () => null,
    listByTrack: async () => [],
    listRecent: async () => notes,
    create: async () => {
      throw new Error("create not stubbed")
    },
    update: async () => {
      throw new Error("update not stubbed")
    },
    delete: async () => {},
    clearAll: async () => {},
  }
}

const mk = (id: string, text: string): Note => ({
  id: id as NoteId,
  trackId: "t-1" as TrackId,
  text,
  timeStart: 0,
  timeEnd: 0,
  createdAt: 1000,
  meta: null,
})

describe("searchNotes", () => {
  it("returns the full recent list on empty / whitespace query", async () => {
    const notes = [mk("1", "alpha"), mk("2", "beta")]
    const result = await searchNotes({ query: "   " }, { notes: makeRepo(notes) })
    expect(result).toEqual(notes)
  })

  it("filters by case-insensitive substring match", async () => {
    const notes = [mk("1", "Alpha beta"), mk("2", "Gamma"), mk("3", "alpaca")]
    const result = await searchNotes({ query: "ALPHA" }, { notes: makeRepo(notes) })
    expect(result.map((n) => n.id)).toEqual(["1"])
  })
})
