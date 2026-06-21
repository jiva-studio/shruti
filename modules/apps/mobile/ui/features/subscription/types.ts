/** View-models for the subscription footer family — kept framework-free and
 *  decoupled from the RevenueCat SDK types so the components stay testable. */

export interface IntroOfferView {
  isFree: boolean
  priceString: string
  periodUnit: string
  periodNumberOfUnits: number
}

export interface PackageView {
  packageId: string
  priceString: string
  billingPeriod: string
  introOffer?: IntroOfferView
}

export interface LegalDocumentView {
  title: string
  link: string
}
