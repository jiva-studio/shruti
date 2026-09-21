import { describe, expect, it } from "vitest"
import { buildTickerPool } from "../buildTickerPool.js"

describe("buildTickerPool", () => {
  it("puts the status label first", () => {
    expect(buildTickerPool("Thinking", ["Who is Uddhava?"])).toEqual([
      "Thinking",
      "Who is Uddhava?",
    ])
  })

  it("leaves out a missing status label", () => {
    expect(buildTickerPool("", ["Who is Uddhava?"])).toEqual(["Who is Uddhava?"])
  })

  it("adds the source labels after the questions", () => {
    const sources = new Map([
      ["s1", { label: "vedabase.io" }],
      ["s2", { label: "gitabase.com" }],
    ])

    expect(buildTickerPool("Reading", ["Who?"], sources)).toEqual([
      "Reading",
      "Who?",
      "vedabase.io",
      "gitabase.com",
    ])
  })

  it("flattens the whitespace of a multi-line question", () => {
    expect(buildTickerPool("", ["  who   is\n Uddhava  "])).toEqual(["who is Uddhava"])
  })

  it("shortens an item too long for the pill", () => {
    const long = "Why does Krishna tell Arjuna that the soul is never born and never dies at all"

    const [item] = buildTickerPool("", [long])

    expect(item).toHaveLength(56)
    expect(item.endsWith("…")).toBe(true)
    expect(long.startsWith(item.slice(0, 20))).toBe(true)
  })

  it("keeps an item that is exactly as long as the pill allows", () => {
    const exact = "x".repeat(56)

    expect(buildTickerPool("", [exact])).toEqual([exact])
  })

  it("drops blank questions and blank source labels", () => {
    const sources = new Map([["s1", { label: "   " }]])

    expect(buildTickerPool("Thinking", ["   ", ""], sources)).toEqual(["Thinking"])
  })

  it("is empty when there is nothing to show", () => {
    expect(buildTickerPool("")).toEqual([])
  })
})
