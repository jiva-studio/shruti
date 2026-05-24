import { describe, expect, it } from "vitest"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"
import { groupReferences } from "../references.js"

const LANG: LanguageCode = "en" as LanguageCode

function makeSources(): ReadonlyMap<string, Source> {
  return new Map<string, Source>([
    [
      "bg",
      {
        id: "bg" as Source["id"],
        names: new Map([[LANG, { fullName: "Bhagavad-gītā", shortName: "BG" }]]),
      },
    ],
    [
      "sb",
      {
        id: "sb" as Source["id"],
        names: new Map([[LANG, { fullName: "Śrīmad-Bhāgavatam", shortName: "SB" }]]),
      },
    ],
  ])
}

const ref = (sourceId: string, ...tokens: string[]): Reference =>
  ({ sourceId: sourceId as Reference["sourceId"], tokens }) as Reference

describe("groupReferences", () => {
  const sources = makeSources()

  it("returns [] for empty input", () => {
    expect(groupReferences([], sources, LANG)).toEqual([])
  })

  it("renders a single reference unchanged", () => {
    expect(groupReferences([ref("bg", "1", "13")], sources, LANG)).toEqual(["BG 1.13"])
  })

  it("collapses two consecutive references into a range", () => {
    const out = groupReferences([ref("bg", "1", "13"), ref("bg", "1", "14")], sources, LANG)
    expect(out).toEqual(["BG 1.13–14"])
  })

  it("uses U+2013 (en-dash), not ASCII hyphen", () => {
    const [chip] = groupReferences([ref("bg", "1", "13"), ref("bg", "1", "14")], sources, LANG)
    expect(chip).toContain("–")
    expect(chip).not.toContain("-")
  })

  it("does NOT collapse non-consecutive references", () => {
    const out = groupReferences([ref("bg", "1", "13"), ref("bg", "1", "15")], sources, LANG)
    expect(out).toEqual(["BG 1.13", "BG 1.15"])
  })

  it("collapses runs of 3+ into a single range", () => {
    const out = groupReferences(
      [ref("bg", "1", "13"), ref("bg", "1", "14"), ref("bg", "1", "15")],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 1.13–15"])
  })

  it("collapses runs of 4 into a single range", () => {
    const out = groupReferences(
      [ref("bg", "2", "1"), ref("bg", "2", "2"), ref("bg", "2", "3"), ref("bg", "2", "4")],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 2.1–4"])
  })

  it("breaks runs across different sourceIds", () => {
    const out = groupReferences(
      [ref("bg", "1", "13"), ref("bg", "1", "14"), ref("sb", "2", "5", "7")],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 1.13–14", "SB 2.5.7"])
  })

  it("collapses two adjacent SB triple-token consecutive verses", () => {
    const out = groupReferences(
      [
        ref("bg", "1", "13"),
        ref("bg", "1", "14"),
        ref("sb", "2", "5", "7"),
        ref("sb", "2", "5", "8"),
      ],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 1.13–14", "SB 2.5.7–8"])
  })

  it("does NOT reorder mixed/interleaved sources (preserves original order)", () => {
    // BG 1.13, SB 2.5, BG 1.14 — the BGs are not contiguous in input,
    // so they remain separate chips. Decision: collapse only adjacent
    // inputs; never reorder.
    const out = groupReferences(
      [ref("bg", "1", "13"), ref("sb", "2", "5"), ref("bg", "1", "14")],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 1.13", "SB 2.5", "BG 1.14"])
  })

  it("does NOT collapse when a token differs other than the last", () => {
    const out = groupReferences([ref("bg", "1", "13"), ref("bg", "2", "14")], sources, LANG)
    expect(out).toEqual(["BG 1.13", "BG 2.14"])
  })

  it("does NOT collapse when token lengths differ", () => {
    const out = groupReferences([ref("bg", "1", "13"), ref("bg", "1", "13", "14")], sources, LANG)
    expect(out).toEqual(["BG 1.13", "BG 1.13.14"])
  })

  it("does NOT collapse when last token isn't a pure non-negative integer", () => {
    const out = groupReferences([ref("bg", "1", "13a"), ref("bg", "1", "14")], sources, LANG)
    expect(out).toEqual(["BG 1.13a", "BG 1.14"])
  })

  it("does NOT collapse a numeric+letter pair on the right side either", () => {
    const out = groupReferences([ref("bg", "1", "13"), ref("bg", "1", "14a")], sources, LANG)
    expect(out).toEqual(["BG 1.13", "BG 1.14a"])
  })

  it("falls back to raw sourceId when source dict is missing", () => {
    const out = groupReferences(
      [ref("unknown", "1", "13"), ref("unknown", "1", "14")],
      undefined,
      LANG
    )
    expect(out).toEqual(["unknown 1.13–14"])
  })

  it("falls back to raw sourceId when source has no names entry", () => {
    const out = groupReferences([ref("ghost", "1", "1")], sources, LANG)
    expect(out).toEqual(["ghost 1.1"])
  })

  it("breaks the run when difference is not exactly 1", () => {
    const out = groupReferences(
      [ref("bg", "1", "13"), ref("bg", "1", "14"), ref("bg", "1", "16")],
      sources,
      LANG
    )
    expect(out).toEqual(["BG 1.13–14", "BG 1.16"])
  })
})
