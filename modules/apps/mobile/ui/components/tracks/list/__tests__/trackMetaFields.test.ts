import { describe, expect, it } from "vitest"
import {
  DEFAULT_TRACK_META_CONFIG,
  normalizeBottomFields,
  normalizeTopKey,
} from "../trackMetaFields.js"

describe("normalizeTopKey", () => {
  it("keeps an explicit empty slot", () => {
    expect(normalizeTopKey(null)).toBeNull()
  })

  it("keeps a field that may be promoted", () => {
    expect(normalizeTopKey("reference")).toBe("reference")
    expect(normalizeTopKey("date")).toBe("date")
  })

  it("falls back when the stored value is missing or not promotable", () => {
    expect(normalizeTopKey(undefined)).toBe(DEFAULT_TRACK_META_CONFIG.top)
    expect(normalizeTopKey("duration" as never)).toBe(DEFAULT_TRACK_META_CONFIG.top)
  })
})

describe("normalizeBottomFields", () => {
  it("appends the fields a stored config never knew about", () => {
    const fields = normalizeBottomFields([{ field: "location", enabled: false }])

    expect(fields[0]).toEqual({ field: "location", enabled: false })
    expect(fields.map((f) => f.field).sort()).toEqual(
      DEFAULT_TRACK_META_CONFIG.bottom.map((f) => f.field).sort()
    )
  })

  it("drops duplicates and unknown keys, keeping the first occurrence", () => {
    const fields = normalizeBottomFields([
      { field: "date", enabled: false },
      { field: "date", enabled: true },
      { field: "speaker", enabled: true } as never,
    ])

    expect(fields.filter((f) => f.field === "date")).toEqual([{ field: "date", enabled: false }])
    expect(fields.map((f) => f.field)).not.toContain("speaker")
  })

  it("yields the default line when nothing was stored", () => {
    expect(normalizeBottomFields(undefined)).toEqual([...DEFAULT_TRACK_META_CONFIG.bottom])
  })
})
