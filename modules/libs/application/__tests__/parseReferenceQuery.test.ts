import { describe, expect, it } from "vitest"
import { parseReferenceQuery } from "../parseReferenceQuery.js"

describe("parseReferenceQuery", () => {
  it("splits scripture refs into tokens", () => {
    expect(parseReferenceQuery("sb 1.8.40")).toEqual(["sb", "1", "8", "40"])
    expect(parseReferenceQuery("BG 2-47")).toEqual(["bg", "2", "47"])
    expect(parseReferenceQuery("sb:1:8:40")).toEqual(["sb", "1", "8", "40"])
  })

  it("returns null for free-text title queries", () => {
    expect(parseReferenceQuery("introduction to bhakti")).toBeNull()
    expect(parseReferenceQuery("")).toBeNull()
    expect(parseReferenceQuery("    ")).toBeNull()
  })

  it("returns null for digit-only or alpha-only queries", () => {
    expect(parseReferenceQuery("12345")).toBeNull()
    expect(parseReferenceQuery("sb bg cc")).toBeNull()
  })
})
