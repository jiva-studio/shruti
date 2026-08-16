import { describe, expect, it } from "vitest"
import { filterNotes, searchNotes } from "../searchNotes.js"
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

describe("searchNotes truncation reporting", () => {
  it("reports truncation when more matched than the cap admits", () => {
    const notes = Array.from({ length: 50 }, (_, i) => mk(String(i), "match"))
    const result = searchNotes(notes, "match", 5)

    expect(result.matches.map((n) => n.id)).toEqual(["0", "1", "2", "3", "4"])
    expect(result.truncated).toBe(true)
  })

  it("does not cry truncation when the matches end exactly at the cap", () => {
    // The off-by-one that a `matches.length === limit` heuristic gets wrong:
    // five matches under a cap of five is the complete answer.
    const notes = Array.from({ length: 5 }, (_, i) => mk(String(i), "match"))
    const result = searchNotes(notes, "match", 5)

    expect(result.matches).toHaveLength(5)
    expect(result.truncated).toBe(false)
  })

  it("stops scanning one match past the cap — the cap is still load-bearing", () => {
    // A getter on `text` counts how far the scan walked. The point of the cap
    // is that a one-letter query over a huge corpus does not touch every note;
    // knowing it truncated may cost one extra match, not a full pass.
    let reads = 0
    const notes: Note[] = Array.from({ length: 1000 }, (_, i) => {
      const note = mk(String(i), "")
      Object.defineProperty(note, "text", {
        get() {
          reads += 1
          return "match"
        },
      })
      return note
    })

    const result = searchNotes(notes, "match", 5)

    expect(result.truncated).toBe(true)
    expect(reads).toBe(6)
  })

  it("reports no truncation when nothing matched", () => {
    const notes = [mk("1", "alpha"), mk("2", "beta")]
    expect(searchNotes(notes, "gamma", 5)).toEqual({ matches: [], truncated: false })
  })

  it("caps a blank query too, and says when it did", () => {
    const notes = Array.from({ length: 10 }, (_, i) => mk(String(i), `note ${i}`))
    expect(searchNotes(notes, "  ", 4).truncated).toBe(true)
    expect(searchNotes(notes, "  ", 40).truncated).toBe(false)
  })
})
