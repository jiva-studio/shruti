import { describe, expect, it } from "vitest"
import { freeTrial, trialDays } from "../trialDays.js"
import type { IntroOfferView } from "../types.js"

const offer = (periodUnit: string, periodNumberOfUnits: number): IntroOfferView => ({
  isFree: true,
  priceString: "0",
  periodUnit,
  periodNumberOfUnits,
})

describe("trialDays", () => {
  it("reads a fortnight the same whether the store counts weeks or days", () => {
    expect(trialDays(offer("WEEK", 2))).toBe(14)
    expect(trialDays(offer("DAY", 14))).toBe(14)
  })

  it("normalizes months and years", () => {
    expect(trialDays(offer("MONTH", 1))).toBe(30)
    expect(trialDays(offer("YEAR", 1))).toBe(365)
  })
})

describe("freeTrial", () => {
  it("only advertises an offer that costs nothing", () => {
    expect(freeTrial({ introOffer: offer("WEEK", 1) })).toBeDefined()
    expect(freeTrial({ introOffer: { ...offer("WEEK", 1), isFree: false } })).toBeUndefined()
    expect(freeTrial({})).toBeUndefined()
  })
})
