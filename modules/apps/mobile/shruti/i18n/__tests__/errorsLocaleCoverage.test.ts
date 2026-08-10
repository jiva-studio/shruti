import { describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"

import bn from "../locales/bn/errors.js"
import de from "../locales/de/errors.js"
import en from "../locales/en/errors.js"
import es from "../locales/es/errors.js"
import fr from "../locales/fr/errors.js"
import hi from "../locales/hi/errors.js"
import hu from "../locales/hu/errors.js"
import itIt from "../locales/it/errors.js"
import pl from "../locales/pl/errors.js"
import pt from "../locales/pt/errors.js"
import ru from "../locales/ru/errors.js"
import srCyrl from "../locales/sr-Cyrl/errors.js"
import srLatn from "../locales/sr-Latn/errors.js"
import uk from "../locales/uk/errors.js"

const BUNDLES = {
  bn,
  de,
  en,
  es,
  fr,
  hi,
  hu,
  it: itIt,
  pl,
  pt,
  ru,
  "sr-Cyrl": srCyrl,
  "sr-Latn": srLatn,
  uk,
} as const

const LOCALES = Object.keys(BUNDLES) as (keyof typeof BUNDLES)[]

/**
 * `errors.downloadFailed` is the notice a silently-failing download now
 * surfaces (offline, every CDN candidate exhausted, an unexpected throw).
 * A locale missing it would fall back to English mid-sentence, so the whole
 * shipped set is asserted rather than a sample.
 *
 * The strings themselves are hand-authored per locale and are NOT asserted
 * word for word — only the properties that make the notice usable.
 */
describe("errors locale bundles", () => {
  it("covers all fourteen shipped locales", () => {
    expect(LOCALES).toHaveLength(14)
  })

  it("resolves errors.downloadFailed in every locale", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en",
      // No fallback: a missing key must fail the assertion, not quietly
      // resolve to the English string.
      fallbackLocale: [],
      messages: Object.fromEntries(LOCALES.map((locale) => [locale, { errors: BUNDLES[locale] }])),
    })
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const message = i18n.global.t("errors.downloadFailed")
      expect(message, locale).not.toBe("errors.downloadFailed")
      expect(message.trim().length, locale).toBeGreaterThan(0)
    }
  })

  it("is translated per locale rather than copied from English", () => {
    for (const locale of LOCALES) {
      if (locale === "en") continue
      expect(BUNDLES[locale].downloadFailed, locale).not.toBe(en.downloadFailed)
    }
  })

  it("keeps the VPN hint in Russian", () => {
    // Russia is where the CDN is blocked, so `ru` is the one locale where a
    // failed download is commonly a VPN that is off — a regional hint the
    // translation carries on its own. It is easy to lose in a sweep that
    // "harmonises" the fourteen strings, so it is pinned here. It is
    // deliberately NOT asserted elsewhere: in the other locales the VPN is
    // noise, and "try again" is the actionable half.
    expect(ru.downloadFailed).toContain("VPN")
  })

  it("labels the storage notice's “Download anyway” button in every locale", () => {
    // The button IS the only escape from the limit short of Settings, so an
    // untranslated one is worse than a missing sentence — it is a dead affordance.
    for (const locale of LOCALES) {
      const label = BUNDLES[locale].downloadStorageFullAction
      expect(label, locale).toBeTypeOf("string")
      expect(label.trim().length, locale).toBeGreaterThan(0)
      if (locale !== "en") expect(label, locale).not.toBe(en.downloadStorageFullAction)
    }
  })

  it("keeps the storage-budget notice distinct from the failure notice", () => {
    // They fire from different branches and mean different things — a track
    // held back by the budget still plays from the stream.
    for (const locale of LOCALES) {
      expect(BUNDLES[locale].downloadStorageFull, locale).not.toBe(BUNDLES[locale].downloadFailed)
    }
  })
})
