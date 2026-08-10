import { describe, expect, it } from "vitest"
import { filterNotes } from "../searchNotes.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"

const mk = (id: string, text: string): Note => ({
  id: id as NoteId,
  trackId: "t-1" as TrackId,
  text,
  timeStart: 0,
  timeEnd: 0,
  createdAt: 1000,
  meta: null,
})

describe("filterNotes", () => {
  it("returns the recent list on empty / whitespace query", () => {
    const notes = [mk("1", "alpha"), mk("2", "beta")]
    expect(filterNotes(notes, "   ")).toEqual(notes)
  })

  it("filters by case-insensitive substring match", () => {
    const notes = [mk("1", "Alpha beta"), mk("2", "Gamma"), mk("3", "alpaca")]
    expect(filterNotes(notes, "ALPHA").map((n) => n.id)).toEqual(["1"])
  })

  it("case-folds beyond ASCII — the reason this is not a SQL LIKE", () => {
    const notes = [mk("1", "Кришна говорит"), mk("2", "Nothing")]
    expect(filterNotes(notes, "кришна").map((n) => n.id)).toEqual(["1"])
  })

  it("finds a match older than the recent window — the filter sees the full corpus", () => {
    // 250 notes; the only match is the very last (oldest) one, well beyond
    // the default 200 result window. A pre-filter truncation would miss it.
    const notes = Array.from({ length: 250 }, (_, i) =>
      mk(String(i), i === 249 ? "needle here" : `filler ${i}`)
    )
    expect(filterNotes(notes, "needle").map((n) => n.id)).toEqual(["249"])
  })

  it("caps the FILTERED results at limit, not the scanned corpus", () => {
    const notes = Array.from({ length: 50 }, (_, i) => mk(String(i), "match"))
    expect(filterNotes(notes, "match", 5)).toHaveLength(5)
  })
})
