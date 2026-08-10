import { describe, expect, it } from "vitest"
import { trackName } from "../trackName.js"
import type { DiscoveryHit } from "../discoveryClient.js"

const hit = (over: Partial<DiscoveryHit>): DiscoveryHit => ({
  item_id: 1,
  media_url: "https://archive.example/talks/0001.mp3",
  score: 0.5,
  ...over,
})

describe("trackName — what to call a recording on screen", () => {
  it("uses the name the archive gave it", () => {
    expect(trackName(hit({ title: "A talk", references: ["SB 7.5.33"] }))).toBe("A talk")
  })

  it("reads a span of references as a span", () => {
    const refs = ["SB 7.5.33", "SB 7.5.34", "SB 7.5.35", "SB 7.5.36", "SB 7.5.37"]
    // En dash, not a hyphen — this is a range, not a compound.
    expect(trackName(hit({ title: "", references: refs }))).toBe("SB 7.5.33–37")
  })

  it("treats a whitespace-only title as no title", () => {
    expect(trackName(hit({ title: "   ", references: ["BG 2.13"] }))).toBe("BG 2.13")
  })

  it("returns a single reference as itself", () => {
    expect(trackName(hit({ references: ["BG 2.13"] }))).toBe("BG 2.13")
  })

  it("never falls back to the address of the file", () => {
    // The defect this guards: with neither a name nor a passage, the tile used
    // to be labelled with the mp3 URL, which says nothing to anybody.
    expect(trackName(hit({ title: "", references: [] }))).toBe("")
    expect(trackName(hit({}))).toBe("")
  })

  it("does not invent a span across different scriptures", () => {
    expect(trackName(hit({ title: "", references: ["SB 7.5.33", "BG 2.13"] }))).toBe("SB 7.5.33")
  })
})
