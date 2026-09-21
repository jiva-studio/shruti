import type { IntroOfferView } from "./types.js"

/** The free trial on a package, if it carries one worth advertising. */
export function freeTrial(pkg: { introOffer?: IntroOfferView }): IntroOfferView | undefined {
  return pkg.introOffer?.isFree ? pkg.introOffer : undefined
}

/** Whole days, so iOS's "2 weeks" and Android's "14 days" read the same. */
export function trialDays(offer: IntroOfferView): number {
  const n = offer.periodNumberOfUnits
  switch (offer.periodUnit) {
    case "WEEK":
      return n * 7
    case "MONTH":
      return n * 30
    case "YEAR":
      return n * 365
    default:
      return n
  }
}
