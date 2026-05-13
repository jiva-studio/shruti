import { describe, expect, it } from "vitest"
import { formatNoteShare } from "../formatNoteShare.js"

// `timeStart`/`timeEnd` are in milliseconds end-to-end (see `Note.timeStart`).
// The formatter does the single ms→s conversion when rendering mm:ss.

describe("formatNoteShare", () => {
  it("renders only the quote and time range when no track context", () => {
    const out = formatNoteShare({ text: "Hello", timeStart: 65_000, timeEnd: 90_000 })
    expect(out).toBe("«Hello»\n\n01:05–01:30")
  })

  it("wraps in guillemets and trims whitespace inside the quote", () => {
    const out = formatNoteShare({ text: "  spaced  ", timeStart: 0, timeEnd: 0 })
    expect(out.startsWith("«spaced»")).toBe(true)
  })

  it("composes author + title on a single line", () => {
    const out = formatNoteShare({
      text: "quote",
      timeStart: 10_000,
      timeEnd: 12_000,
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
      timeStart: 5_000,
      timeEnd: 5_000,
      track: { authorName: "A" },
    })
    expect(out).toBe("«quote»\n\nA\n00:05")
  })

  it("renders hours when the timestamp exceeds 1h", () => {
    const out = formatNoteShare({ text: "q", timeStart: 3_661_000, timeEnd: 3_665_000 })
    expect(out).toContain("1:01:01–1:01:05")
  })

  it("collapses a zero-length range to a single timestamp", () => {
    const out = formatNoteShare({ text: "q", timeStart: 30_000, timeEnd: 30_000 })
    expect(out).toContain("00:30")
    expect(out).not.toContain("–")
  })

  it("treats sub-second values as 00:00", () => {
    const out = formatNoteShare({ text: "q", timeStart: 500, timeEnd: 999 })
    expect(out).toContain("00:00")
  })
})
