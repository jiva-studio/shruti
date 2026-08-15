import { describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import { formatListeningDuration } from "../formatListeningDuration.js"
import deApp from "@lectorium/i18n/locales/de/app.js"
import enApp from "@lectorium/i18n/locales/en/app.js"
import hiApp from "@lectorium/i18n/locales/hi/app.js"
import ruApp from "@lectorium/i18n/locales/ru/app.js"

// Real vue-i18n over the real shipped bundles — the point of the test is that
// the chat cards read the localized strings, not a hardcoded English copy.
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { de: { app: deApp }, en: { app: enApp }, hi: { app: hiApp }, ru: { app: ruApp } },
})

type TestLocale = "de" | "en" | "hi" | "ru"

function durationFor(locale: TestLocale, seconds: number): string {
  return formatListeningDuration(seconds, (key, named) =>
    i18n.global.t(key, named ?? {}, { locale })
  )
}

describe("formatTrackDate", () => {
  it("uses the numeric ru order", () => {
    expect(formatTrackDate("2024-03-15", "ru")).toBe("15.03.2024")
  })

  it("uses English month abbreviations for en", () => {
    expect(formatTrackDate("2024-03-15", "en")).toBe("15 Mar 2024")
  })

  it("localizes the month for other locales", () => {
    expect(formatTrackDate("2024-03-15", "de")).toBe("15 Mär 2024")
    expect(formatTrackDate("2024-03-15", "hi")).toBe("15 मार्च 2024")
  })

  it("passes through anything that is not a full ISO date", () => {
    for (const locale of ["ru", "en", "de", "hi"]) {
      expect(formatTrackDate("2024", locale)).toBe("2024")
      expect(formatTrackDate("", locale)).toBe("")
    }
  })
})

describe("localized track duration", () => {
  it("localizes hours and minutes", () => {
    const seconds = 3600 + 23 * 60
    expect(durationFor("en", seconds)).toBe("1h 23m")
    expect(durationFor("ru", seconds)).toBe("1ч 23м")
    expect(durationFor("de", seconds)).toBe("1Std 23Min")
    expect(durationFor("hi", seconds)).toBe("1घं 23मि")
  })

  it("localizes sub-hour durations", () => {
    const seconds = 47 * 60
    expect(durationFor("en", seconds)).toBe("47m")
    expect(durationFor("ru", seconds)).toBe("47м")
    expect(durationFor("de", seconds)).toBe("47Min")
    expect(durationFor("hi", seconds)).toBe("47मि")
  })
})
