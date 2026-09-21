import { describe, expect, it } from "vitest"
import { devMockPackages, isEmptyOfferingsError } from "../offerings.js"

describe("isEmptyOfferingsError", () => {
  it("recognizes RevenueCat's configuration error", () => {
    expect(isEmptyOfferingsError({ code: "23" })).toBe(true)
  })

  it("passes every other failure through", () => {
    expect(isEmptyOfferingsError({ code: "7" })).toBe(false)
    // The SDK reports the code as a string; a numeric one is a different shape.
    expect(isEmptyOfferingsError({ code: 23 })).toBe(false)
    expect(isEmptyOfferingsError(new Error("network"))).toBe(false)
    expect(isEmptyOfferingsError(undefined)).toBe(false)
  })
})

describe("devMockPackages", () => {
  it("offers both standard Rc plans, with the trial on the annual one", () => {
    const [monthly, annual] = devMockPackages()
    expect(monthly!.packageId).toBe("$rc_monthly")
    expect(monthly!.introOffer).toBeUndefined()
    expect(annual!.packageId).toBe("$rc_annual")
    expect(annual!.introOffer?.isFree).toBe(true)
  })
})
