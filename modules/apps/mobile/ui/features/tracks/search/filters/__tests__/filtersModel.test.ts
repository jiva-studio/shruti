import { describe, expect, it } from "vitest"
import { h } from "vue"
import {
  asDate,
  asMulti,
  asSingle,
  clearSection,
  composeDateEdge,
  getDateSummary,
  getMultiCount,
  getMultiSelected,
  getSectionSummary,
  getSingleValue,
  isMultiSelected,
  parseDateEdge,
  setDateEdge,
  setMultiSelected,
  toggleSingleValue,
} from "../filtersModel.js"
import type { DateSectionDef, FiltersModel, MultiSectionDef, SingleSectionDef } from "../types.js"

const icon = { setup: () => () => h("span") }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const authorsSection: MultiSectionDef = {
  kind: "multi",
  key: "authors",
  model: "authors",
  title: "Authors",
  icon,
  items: [
    { id: "a1", title: "Prabhupada" },
    { id: "a2", title: "Gour Govinda" },
  ],
}

const durationSection: SingleSectionDef = {
  kind: "single",
  key: "duration",
  model: "duration",
  title: "Duration",
  icon,
  items: [
    { id: "short", title: "Under 30 min" },
    { id: "long", title: "Over an hour" },
  ],
}

const datesSection: DateSectionDef = {
  kind: "date",
  key: "dates",
  title: "Dates",
  icon,
  years: [2012, 2001],
  monthLabels: MONTHS,
}

describe("multi-value sections", () => {
  it("reads an absent key as an empty selection", () => {
    expect(getMultiSelected({}, "authors")).toEqual([])
    expect(getMultiCount({}, "authors")).toBe(0)
    expect(isMultiSelected({}, "authors", "a1")).toBe(false)
  })

  it("adds a checked id without touching the input", () => {
    const before: FiltersModel = { authors: ["a1"] }
    const after = setMultiSelected(before, "authors", "a2", true)
    expect(after.authors).toEqual(["a1", "a2"])
    expect(before.authors).toEqual(["a1"])
    expect(after).not.toBe(before)
  })

  it("ignores a re-check of an id already selected", () => {
    const after = setMultiSelected({ authors: ["a1"] }, "authors", "a1", true)
    expect(after.authors).toEqual(["a1"])
  })

  it("drops an unchecked id and leaves the rest in order", () => {
    const after = setMultiSelected({ authors: ["a1", "a2", "a3"] }, "authors", "a2", false)
    expect(after.authors).toEqual(["a1", "a3"])
  })

  it("unchecking an id that was never there is a no-op selection", () => {
    const after = setMultiSelected({ authors: ["a1"] }, "authors", "zz", false)
    expect(after.authors).toEqual(["a1"])
  })

  it("keeps other sections untouched when one changes", () => {
    const after = setMultiSelected({ authors: ["a1"], tags: ["t1"] }, "tags", "t2", true)
    expect(after.authors).toEqual(["a1"])
    expect(after.tags).toEqual(["t1", "t2"])
  })
})

describe("single-value sections", () => {
  it("selects a value when none is set", () => {
    expect(toggleSingleValue({}, "duration", "short").duration).toBe("short")
  })

  it("replaces the value when a different one is picked", () => {
    expect(toggleSingleValue({ duration: "short" }, "duration", "long").duration).toBe("long")
  })

  it("clears the value when the same one is picked again", () => {
    const after = toggleSingleValue({ duration: "short" }, "duration", "short")
    expect(after.duration).toBeUndefined()
    expect(getSingleValue(after, "duration")).toBeUndefined()
  })
})

describe("date edges", () => {
  it("parses a bare year and a year-month", () => {
    expect(parseDateEdge("2001")).toEqual({ year: 2001, month: undefined })
    expect(parseDateEdge("2001-03")).toEqual({ year: 2001, month: 3 })
  })

  it("rejects malformed, absent and out-of-range edges", () => {
    expect(parseDateEdge(undefined)).toBeNull()
    expect(parseDateEdge("")).toBeNull()
    expect(parseDateEdge("20o1")).toBeNull()
    expect(parseDateEdge("2001-3")).toBeNull()
    expect(parseDateEdge("2001-00")).toBeNull()
    expect(parseDateEdge("2001-13")).toBeNull()
  })

  it("composes an edge, zero-padding the month", () => {
    expect(composeDateEdge(2001, undefined)).toBe("2001")
    expect(composeDateEdge(2001, 3)).toBe("2001-03")
    expect(composeDateEdge(2001, 12)).toBe("2001-12")
  })

  it("drops the month when the year is cleared", () => {
    expect(composeDateEdge(undefined, 3)).toBeUndefined()
  })

  it("stores an edge and clears it again", () => {
    const set = setDateEdge({}, "dateFrom", "2001-03")
    expect(set.dateFrom).toBe("2001-03")
    expect(setDateEdge(set, "dateFrom", undefined).dateFrom).toBeUndefined()
  })

  it("summarises both closed and open-ended ranges", () => {
    expect(getDateSummary({}, datesSection)).toBe("")
    expect(getDateSummary({ dateFrom: "2001-03", dateTo: "2012" }, datesSection)).toBe(
      "Mar 2001 – 2012"
    )
    expect(getDateSummary({ dateFrom: "2001" }, datesSection)).toBe("2001 – …")
    expect(getDateSummary({ dateTo: "2012-12" }, datesSection)).toBe("… – Dec 2012")
  })

  it("falls back to the month number when labels are missing", () => {
    const sparse: DateSectionDef = { ...datesSection, monthLabels: [] }
    expect(getDateSummary({ dateFrom: "2001-03" }, sparse)).toBe("3 2001 – …")
  })

  it("treats a malformed stored edge as unset", () => {
    expect(getDateSummary({ dateFrom: "nonsense" }, datesSection)).toBe("")
  })
})

describe("section summaries", () => {
  it("joins the titles of the selected multi items", () => {
    expect(getSectionSummary({ authors: ["a1", "a2"] }, authorsSection)).toBe(
      "Prabhupada, Gour Govinda"
    )
  })

  it("is empty when nothing is selected", () => {
    expect(getSectionSummary({}, authorsSection)).toBe("")
    expect(getSectionSummary({}, durationSection)).toBe("")
  })

  it("skips a selected id the section no longer offers", () => {
    expect(getSectionSummary({ authors: ["a1", "gone"] }, authorsSection)).toBe("Prabhupada")
  })

  it("names the selected single item, and is empty for an unknown id", () => {
    expect(getSectionSummary({ duration: "long" }, durationSection)).toBe("Over an hour")
    expect(getSectionSummary({ duration: "gone" }, durationSection)).toBe("")
  })

  it("routes a date section through the range summary", () => {
    expect(getSectionSummary({ dateFrom: "2001" }, datesSection)).toBe("2001 – …")
  })
})

describe("kind discriminators", () => {
  it("returns the section only for its own kind", () => {
    expect(asMulti(authorsSection)).toBe(authorsSection)
    expect(asMulti(durationSection)).toBeNull()
    expect(asSingle(durationSection)).toBe(durationSection)
    expect(asSingle(datesSection)).toBeNull()
    expect(asDate(datesSection)).toBe(datesSection)
    expect(asDate(authorsSection)).toBeNull()
  })

  it("passes a null section through", () => {
    expect(asMulti(null)).toBeNull()
    expect(asSingle(null)).toBeNull()
    expect(asDate(null)).toBeNull()
  })
})

describe("clearing a section by key", () => {
  it("drops both edges for the date key", () => {
    const after = clearSection({ dateFrom: "2001", dateTo: "2012", tags: ["t1"] }, "dates")
    expect(after.dateFrom).toBeUndefined()
    expect(after.dateTo).toBeUndefined()
    expect(after.tags).toEqual(["t1"])
  })

  it("drops one ordinary section and keeps the others", () => {
    const after = clearSection({ authors: ["a1"], tags: ["t1"] }, "authors")
    expect("authors" in after).toBe(false)
    expect(after.tags).toEqual(["t1"])
  })

  it("returns the same object for a key that is not set", () => {
    const before: FiltersModel = { tags: ["t1"] }
    expect(clearSection(before, "authors")).toBe(before)
    expect(clearSection(before, "nope")).toBe(before)
  })
})
