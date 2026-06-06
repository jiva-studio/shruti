import { describe, expect, it } from "vitest"
import { dateRangeBounds } from "../dateFilters.js"

describe("dateRangeBounds", () => {
  it("returns no bounds when both edges are absent", () => {
    expect(dateRangeBounds(undefined, undefined)).toEqual({})
  })

  it("expands a year-only lower bound to Jan 1st", () => {
    expect(dateRangeBounds("2001", undefined)).toEqual({ gte: "2001-01-01" })
  })

  it("expands a year-only upper bound to the start of the next year (exclusive)", () => {
    expect(dateRangeBounds(undefined, "2012")).toEqual({ lt: "2013-01-01" })
  })

  it("expands a month lower bound to the 1st of that month", () => {
    expect(dateRangeBounds("2001-03", undefined)).toEqual({ gte: "2001-03-01" })
  })

  it("makes a month upper bound exclusive of the following month", () => {
    expect(dateRangeBounds(undefined, "2001-06")).toEqual({ lt: "2001-07-01" })
  })

  it("rolls a December upper bound into the next year", () => {
    expect(dateRangeBounds(undefined, "2001-12")).toEqual({ lt: "2002-01-01" })
  })

  it("combines both edges", () => {
    expect(dateRangeBounds("1974-09", "1977")).toEqual({
      gte: "1974-09-01",
      lt: "1978-01-01",
    })
  })

  it("zero-pads single-digit months in the bounds", () => {
    expect(dateRangeBounds("2005-01", "2005-08")).toEqual({
      gte: "2005-01-01",
      lt: "2005-09-01",
    })
  })

  it("ignores malformed edges", () => {
    expect(dateRangeBounds("nope", "2012-13")).toEqual({})
  })
})
