import { describe, expect, it } from "vitest"
import { parseOutline } from "../contentRowMappers.js"

describe("parseOutline", () => {
  it("maps the catalog's entries to domain chapters", () => {
    const raw = JSON.stringify([
      { title: "One", start: 0, end: 1000 },
      { title: "Two", start: 1000, end: 2000 },
    ])
    expect(parseOutline(raw)).toEqual([
      { title: "One", startMs: 0, endMs: 1000 },
      { title: "Two", startMs: 1000, endMs: 2000 },
    ])
  })

  it("trims the title", () => {
    expect(parseOutline(JSON.stringify([{ title: "  One  ", start: 0, end: 1 }]))?.[0].title).toBe(
      "One"
    )
  })

  it("has no outline for absent or unparseable input", () => {
    expect(parseOutline(null)).toBeNull()
    expect(parseOutline("")).toBeNull()
    expect(parseOutline("{not json")).toBeNull()
    expect(parseOutline(JSON.stringify({ title: "One" }))).toBeNull()
  })

  it("drops an entry with no title", () => {
    expect(parseOutline(JSON.stringify([{ title: "  ", start: 0, end: 1000 }]))).toBeNull()
  })

  it("drops an entry whose span would never match a lookup", () => {
    const raw = JSON.stringify([
      { title: "No end", start: 0 },
      { title: "Zero length", start: 100, end: 100 },
      { title: "Backwards", start: 200, end: 100 },
      { title: "Text end", start: 0, end: "1000" },
    ])
    expect(parseOutline(raw)).toBeNull()
  })

  it("keeps the entries around a malformed one", () => {
    const raw = JSON.stringify([{ title: "Bad" }, null, { title: "Good", start: 0, end: 1000 }])
    expect(parseOutline(raw)).toEqual([{ title: "Good", startMs: 0, endMs: 1000 }])
  })

  it("has no outline for an empty list", () => {
    expect(parseOutline("[]")).toBeNull()
  })
})
