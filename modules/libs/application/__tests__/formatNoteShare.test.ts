import { describe, expect, it } from "vitest"
import { formatNoteShare } from "../formatNoteShare.js"

describe("formatNoteShare", () => {
  it("renders only the quote and time range when no track context", () => {
    const out = formatNoteShare({ text: "Hello", timeStart: 65, timeEnd: 90 })
    expect(out).toBe("«Hello»\n\n01:05–01:30")
  })

  it("wraps in guillemets and trims whitespace inside the quote", () => {
    const out = formatNoteShare({ text: "  spaced  ", timeStart: 0, timeEnd: 0 })
    expect(out.startsWith("«spaced»")).toBe(true)
  })

  it("composes author + title on a single line", () => {
    const out = formatNoteShare({
      text: "quote",
      timeStart: 10,
      timeEnd: 12,
      track: { authorName: "Author Name", title: "Lecture Title" },
    })
    expect(out).toContain("Author Name — Lecture Title")
  })

  it("joins date, location, and reference with bullet separators", () => {
    const out = formatNoteShare({
      text: "quote",
      timeStart: 0,
      timeEnd: 0,
      track: {
        authorName: "A",
        title: "T",
        date: "2026-05-13",
        locationName: "Bombay",
        reference: "BG 2.13",
      },
    })
    expect(out).toContain("2026-05-13 · Bombay · BG 2.13")
  })

  it("skips optional fields when absent", () => {
    const out = formatNoteShare({
      text: "quote",
      timeStart: 5,
      timeEnd: 5,
      track: { authorName: "A" },
    })
    expect(out).toBe("«quote»\n\nA\n00:05")
  })

  it("renders hours when the timestamp exceeds 1h", () => {
    const out = formatNoteShare({ text: "q", timeStart: 3661, timeEnd: 3665 })
    expect(out).toContain("1:01:01–1:01:05")
  })

  it("collapses a zero-length range to a single timestamp", () => {
    const out = formatNoteShare({ text: "q", timeStart: 30, timeEnd: 30 })
    expect(out).toContain("00:30")
    expect(out).not.toContain("–")
  })
})
