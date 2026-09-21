import { describe, it, expect } from "vitest"
import { EMPTY_FILTERS, createFiltersState, parsePersistedFilters } from "../persistedFilters.js"

describe("parsePersistedFilters", () => {
  it("reads a full payload", () => {
    const raw = JSON.stringify({
      ...EMPTY_FILTERS,
      authorIds: ["a1"],
      languageCodes: ["ru"],
      duration: ["short"],
      sort: "byDateAsc",
      dateFrom: "2020",
    })

    expect(parsePersistedFilters(raw)).toEqual({
      ...EMPTY_FILTERS,
      authorIds: ["a1"],
      languageCodes: ["ru"],
      duration: ["short"],
      sort: "byDateAsc",
      dateFrom: "2020",
    })
  })

  it("fills absent and null keys from the empty tuple", () => {
    expect(parsePersistedFilters('{"authorIds":["a1"],"sort":null}')).toEqual({
      ...EMPTY_FILTERS,
      authorIds: ["a1"],
    })
  })

  it("returns undefined for a corrupt or non-object value", () => {
    expect(parsePersistedFilters("{oops")).toBeUndefined()
    expect(parsePersistedFilters("null")).toBeUndefined()
    expect(parsePersistedFilters("7")).toBeUndefined()
  })
})

describe("createFiltersState", () => {
  it("round-trips a payload through apply and snapshot", () => {
    const state = createFiltersState()

    state.apply({ ...EMPTY_FILTERS, topicIds: ["t1"], dateTo: "2024-06" })

    expect(state.topicIds.value).toEqual(["t1"])
    expect(state.snapshot()).toEqual({ ...EMPTY_FILTERS, topicIds: ["t1"], dateTo: "2024-06" })
  })

  it("clear drops every selection", () => {
    const state = createFiltersState()
    state.apply({ ...EMPTY_FILTERS, authorIds: ["a1"], sort: "byDateAsc" })

    state.clear()

    expect(state.snapshot()).toEqual(EMPTY_FILTERS)
  })
})
