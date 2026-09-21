import { describe, expect, it } from "vitest"
import { matchCollections, matchTopics, normalizeNeedle } from "../groupingMatch.js"

const collections = [
  { id: "c1", name: "Бхагавад-гита", coverUrl: "c1.jpg" },
  { id: "c2", name: "Шримад-Бхагаватам" },
]

const topics = [
  { id: "t1", shortName: "Бхакти", fullName: "Преданное служение", coverUrl: "t1.jpg" },
  { id: "t2", shortName: "", fullName: "Смирение" },
]

describe("normalizeNeedle", () => {
  it("trims and lowercases", () => {
    expect(normalizeNeedle("  Гита ")).toBe("гита")
  })
})

describe("matchCollections", () => {
  it("matches on the name regardless of case", () => {
    expect(matchCollections(collections, "гита", 10).map((h) => h.id)).toEqual(["c1"])
  })

  it("marks every hit as a collection and keeps the cover", () => {
    expect(matchCollections(collections, "гита", 10)[0]).toMatchObject({
      kind: "collection",
      coverUrl: "c1.jpg",
    })
  })

  it("stops at the limit", () => {
    expect(matchCollections(collections, "бхага", 1)).toHaveLength(1)
  })
})

describe("matchTopics", () => {
  it("matches the full name as well as the short one", () => {
    expect(matchTopics(topics, "преданное", 10).map((h) => h.id)).toEqual(["t1"])
  })

  it("prefixes the name with a hash", () => {
    expect(matchTopics(topics, "бхакти", 10)[0]!.name).toBe("#Бхакти")
  })

  it("falls back to the full name when there is no short one", () => {
    expect(matchTopics(topics, "смирение", 10)[0]!.name).toBe("#Смирение")
  })

  it("returns nothing when there is no room left", () => {
    expect(matchTopics(topics, "бхакти", 0)).toEqual([])
  })
})
