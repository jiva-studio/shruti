import { describe, expect, it } from "vitest"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"
import {
  countActiveFilters,
  defaultFilterSections,
  hasAnyFilter,
  sameLanguageSet,
} from "../activeFilters.js"

const DEFAULT_SORT = "byDateAsc"

describe("sameLanguageSet", () => {
  it("ignores order", () => {
    expect(sameLanguageSet(["ru", "en"], ["en", "ru"])).toBe(true)
  })

  it("rejects a different length", () => {
    expect(sameLanguageSet(["ru"], ["ru", "en"])).toBe(false)
  })
})

describe("hasAnyFilter", () => {
  it("is false for an empty model", () => {
    expect(hasAnyFilter({})).toBe(false)
  })

  it("is false for empty lists and empty strings", () => {
    expect(hasAnyFilter({ authors: [], duration: "", sort: "" } as FiltersModel)).toBe(false)
  })

  it("is true for any list value", () => {
    expect(hasAnyFilter({ topics: ["t1"] } as FiltersModel)).toBe(true)
  })

  it("is true for a date bound alone", () => {
    expect(hasAnyFilter({ dateTo: "2020" } as FiltersModel)).toBe(true)
  })
})

describe("countActiveFilters", () => {
  it("counts a pristine install as zero", () => {
    const f = { languages: ["ru"], sort: DEFAULT_SORT } as FiltersModel
    expect(countActiveFilters(f, { seededLanguages: ["ru"], defaultSort: DEFAULT_SORT })).toBe(0)
  })

  it("counts a language selection that differs from the seed", () => {
    const f = { languages: ["ru", "en"] } as FiltersModel
    expect(countActiveFilters(f, { seededLanguages: ["ru"] })).toBe(2)
  })

  it("counts each list value and both date bounds as one", () => {
    const f = {
      authors: ["a1", "a2"],
      topics: ["t1"],
      dateFrom: "2019",
      dateTo: "2020",
    } as FiltersModel
    expect(countActiveFilters(f)).toBe(4)
  })

  it("counts a non-default sort and a duration", () => {
    const f = { sort: "byDateDesc", duration: "short" } as FiltersModel
    expect(countActiveFilters(f, { defaultSort: DEFAULT_SORT })).toBe(2)
  })

  it("counts any sort when there is no default to exclude", () => {
    expect(countActiveFilters({ sort: DEFAULT_SORT } as FiltersModel)).toBe(1)
  })
})

describe("defaultFilterSections", () => {
  it("names the seeded language and the unset sort", () => {
    const f = { languages: ["ru"] } as FiltersModel
    const sections = defaultFilterSections(f, { seededLanguages: ["ru"] })
    expect([...sections].sort()).toEqual(["languages", "sort"])
  })

  it("drops the language once the user has changed it", () => {
    const f = { languages: ["en"], sort: "byDateDesc" } as FiltersModel
    expect(defaultFilterSections(f, { seededLanguages: ["ru"] }).size).toBe(0)
  })
})
