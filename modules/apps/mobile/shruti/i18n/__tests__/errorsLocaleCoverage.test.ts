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

  it("names the VPN in every locale", () => {
    // The reason the string was reworded: in the regions most of the corpus
    // is listened in, a dead CDN is usually a VPN that is on (or off). The
    // acronym stays Latin everywhere, including sr-Cyrl — which is
    // transliterated by a generator that has to be told to leave it alone.
    for (const locale of LOCALES) {
      expect(BUNDLES[locale].downloadFailed, locale).toContain("VPN")
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
