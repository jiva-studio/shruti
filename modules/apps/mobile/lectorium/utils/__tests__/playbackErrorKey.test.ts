import { describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"

import bn from "@lectorium/i18n/locales/bn/errors.js"
import de from "@lectorium/i18n/locales/de/errors.js"
import en from "@lectorium/i18n/locales/en/errors.js"
import es from "@lectorium/i18n/locales/es/errors.js"
import fr from "@lectorium/i18n/locales/fr/errors.js"
import hi from "@lectorium/i18n/locales/hi/errors.js"
import hu from "@lectorium/i18n/locales/hu/errors.js"
import itIt from "@lectorium/i18n/locales/it/errors.js"
import pl from "@lectorium/i18n/locales/pl/errors.js"
import pt from "@lectorium/i18n/locales/pt/errors.js"
import ru from "@lectorium/i18n/locales/ru/errors.js"
import srCyrl from "@lectorium/i18n/locales/sr-Cyrl/errors.js"
import srLatn from "@lectorium/i18n/locales/sr-Latn/errors.js"
import uk from "@lectorium/i18n/locales/uk/errors.js"

import { playbackErrorKey } from "../playbackErrorKey.js"

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

describe("playbackErrorKey", () => {
  it("separates the permanent refusal from the retryable one", () => {
    // `errors.playbackFailed` ends in "check your connection and try again",
    // advice a lecture with no audio file can never satisfy.
    expect(playbackErrorKey("no-audio-available")).toBe("errors.noAudioForLecture")
    expect(playbackErrorKey("engine-failed")).toBe("errors.playbackFailed")
  })
})

describe("the keys it returns", () => {
  it("resolve in all fourteen shipped locales", () => {
    expect(LOCALES).toHaveLength(14)
    const i18n = createI18n({
      legacy: false,
      locale: "en",
      // No fallback — a locale missing the key must fail here rather than
      // quietly resolve to English at runtime.
      fallbackLocale: [],
      messages: Object.fromEntries(LOCALES.map((l) => [l, { errors: BUNDLES[l] }])),
    })
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      for (const key of ["errors.noAudioForLecture", "errors.playbackFailed"]) {
        const message = i18n.global.t(key)
        expect(message, `${locale}/${key}`).not.toBe(key)
        expect(message.trim().length, `${locale}/${key}`).toBeGreaterThan(0)
      }
    }
  })

  it("are worded differently in every locale", () => {
    // The whole point of the second key: same string would put the
    // unfollowable retry instruction back on the permanent failure.
    for (const locale of LOCALES) {
      expect(BUNDLES[locale].noAudioForLecture, locale).not.toBe(BUNDLES[locale].playbackFailed)
    }
  })

  it("is translated per locale rather than copied from English", () => {
    for (const locale of LOCALES) {
      if (locale === "en") continue
      expect(BUNDLES[locale].noAudioForLecture, locale).not.toBe(en.noAudioForLecture)
    }
  })
})
