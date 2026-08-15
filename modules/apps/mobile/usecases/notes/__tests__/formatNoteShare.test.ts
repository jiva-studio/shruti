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
      locale: "en",
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
    expect(out).toContain("13 May 2026 · Bombay · BG 2.13")
  })

  it("localizes the lecture date to the caller's language", () => {
    // The shared text used to carry the raw ISO date while every other
    // surface localized it, so a note read `1996-03-14` on the clipboard
    // and `14.03.1996` on the card it was copied from.
    const track = { date: "1996-03-14" }
    const args = { text: "q", timeStart: 0, timeEnd: 0, track }
    expect(formatNoteShare({ ...args, locale: "ru" })).toContain("14.03.1996")
    expect(formatNoteShare({ ...args, locale: "en" })).toContain("14 Mar 1996")
    expect(formatNoteShare({ ...args, locale: "ru" })).not.toContain("1996-03-14")
  })

  it("passes a year-only date through — many lectures carry no full date", () => {
    const out = formatNoteShare({
      text: "q",
      locale: "ru",
      timeStart: 0,
      timeEnd: 0,
      track: { date: "1996" },
    })
    expect(out).toContain("1996")
  })

  it("falls back to English when no locale is supplied", () => {
    const out = formatNoteShare({
      text: "q",
      timeStart: 0,
      timeEnd: 0,
      track: { date: "1996-03-14" },
    })
    expect(out).toContain("14 Mar 1996")
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
