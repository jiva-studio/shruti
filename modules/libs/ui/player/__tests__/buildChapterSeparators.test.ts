import { describe, expect, it } from "vitest"
import { buildChapterSeparators } from "../buildChapterSeparators.js"

const chapters = [
  { title: "Opening", startMs: 0, endMs: 1000 },
  { title: "Verse 13", startMs: 2500, endMs: 5000 },
  { title: "Questions", startMs: 7500, endMs: 10000 },
]

describe("buildChapterSeparators", () => {
  it("puts a chapter on the bar its start falls on", () => {
    const map = buildChapterSeparators(5, chapters, 10_000, 0)

    expect([...map.keys()]).toEqual([1, 3])
    expect(map.get(1)).toEqual({ title: "Verse 13", startMs: 2500, active: false })
  })

  it("drops a chapter that would land on the first bar", () => {
    const map = buildChapterSeparators(5, chapters, 10_000, 0)

    expect([...map.values()].some((s) => s.title === "Opening")).toBe(false)
  })

  it("marks the chapter the playhead is inside as active", () => {
    const map = buildChapterSeparators(5, chapters, 10_000, 3000)

    expect(map.get(1)!.active).toBe(true)
    expect(map.get(3)!.active).toBe(false)
  })

  it("moves the active chapter as the playhead advances", () => {
    const map = buildChapterSeparators(5, chapters, 10_000, 8000)

    expect(map.get(3)!.active).toBe(true)
  })

  it("clamps a chapter that starts past the end of the recording", () => {
    const map = buildChapterSeparators(
      5,
      [{ title: "Late", startMs: 99_000, endMs: 100_000 }],
      10_000,
      0
    )

    expect([...map.keys()]).toEqual([4])
  })

  it("is empty without a known duration", () => {
    expect(buildChapterSeparators(5, chapters, 0, 0).size).toBe(0)
  })

  it("is empty without chapters", () => {
    expect(buildChapterSeparators(5, undefined, 10_000, 0).size).toBe(0)
    expect(buildChapterSeparators(5, [], 10_000, 0).size).toBe(0)
  })

  it("is empty when there is a single bar to draw on", () => {
    expect(buildChapterSeparators(1, chapters, 10_000, 0).size).toBe(0)
  })
})
