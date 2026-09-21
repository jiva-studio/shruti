import { describe, expect, it } from "vitest"
import { buildDiscoveryFilter, dayBefore } from "../discoveryFacets.js"

const empty = { authors: [], languages: [], sources: [] }

describe("dayBefore", () => {
  it("steps back one UTC day", () => {
    expect(dayBefore("2020-01-01")).toBe("2019-12-31")
  })
})

describe("buildDiscoveryFilter", () => {
  it("omits every empty facet", () => {
    expect(buildDiscoveryFilter(empty)).toEqual({})
  })

  it("passes the non-empty facets through", () => {
    expect(
      buildDiscoveryFilter({ authors: ["Radhanath Swami"], languages: ["en"], sources: ["SB"] })
    ).toEqual({ authors: ["Radhanath Swami"], languages: ["en"], sources: ["SB"] })
  })

  it("turns a year range into inclusive ISO days", () => {
    expect(buildDiscoveryFilter({ ...empty, dateFrom: "2019", dateTo: "2020" })).toEqual({
      date_from: "2019-01-01",
      date_to: "2020-12-31",
    })
  })

  it("accepts an open-ended lower bound", () => {
    expect(buildDiscoveryFilter({ ...empty, dateFrom: "2019-05" })).toEqual({
      date_from: "2019-05-01",
    })
  })
})
