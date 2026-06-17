import { describe, expect, it } from "vitest"
import { searchNotes } from "../searchNotes.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

function makeRepo(notes: readonly Note[], onListRecent?: (limit: number) => void): INoteRepository {
  return {
    getById: async () => null,
    listByTrack: async () => [],
    // Honour the limit like the real repo so tests can assert that a query
    // scans the full corpus rather than only the recent window.
    listRecent: async (limit: number) => {
      onListRecent?.(limit)
      return notes.slice(0, limit)
    },
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

  it("finds a match older than the recent window — filter runs over the full corpus", async () => {
    // 250 notes; the only match is the very last (oldest) one, well beyond
    // the default 200 recent window. A pre-filter truncation would miss it.
    const notes = Array.from({ length: 250 }, (_, i) =>
      mk(String(i), i === 249 ? "needle here" : `filler ${i}`)
    )
    const result = await searchNotes({ query: "needle" }, { notes: makeRepo(notes) })
    expect(result.map((n) => n.id)).toEqual(["249"])
  })

  it("scans the corpus with a large cap, not the result limit, when querying", async () => {
    let lastLimit = 0
    const notes = [mk("1", "match")]
    await searchNotes(
      { query: "match", limit: 10 },
      { notes: makeRepo(notes, (l) => (lastLimit = l)) }
    )
    expect(lastLimit).toBeGreaterThan(10_000)
  })

  it("caps the FILTERED results at limit, not the scanned corpus", async () => {
    const notes = Array.from({ length: 50 }, (_, i) => mk(String(i), "match"))
    const result = await searchNotes({ query: "match", limit: 5 }, { notes: makeRepo(notes) })
    expect(result).toHaveLength(5)
  })
})
