// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { PLURAL_RULES, SUPPORTED_LOCALES, detectLocale, privacyPolicyUrl } from "../index.js"

function withLanguage(value: string): void {
  vi.spyOn(navigator, "language", "get").mockReturnValue(value)
}

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState({}, "", "/")
})

describe("privacyPolicyUrl", () => {
  it("points at the locale's own page where the site has one", () => {
    expect(privacyPolicyUrl("ru")).toBe("https://shruti.app/ru/privacy")
    expect(privacyPolicyUrl("sr-Latn")).toBe("https://shruti.app/sr-latn/privacy")
    expect(privacyPolicyUrl("sr-Cyrl")).toBe("https://shruti.app/sr-cyrl/privacy")
  })

  it("falls back to English for a locale the site does not carry", () => {
    for (const loc of ["en", "de", "hi", "bn", "pl", "not-a-locale"]) {
      expect(privacyPolicyUrl(loc)).toBe("https://shruti.app/en/privacy")
    }
  })
})

describe("detectLocale", () => {
  it("takes the ?locale= override over the device language", () => {
    withLanguage("ru")
    window.history.replaceState({}, "", "/?locale=de")
    expect(detectLocale()).toBe("de")
  })

  it("ignores an override that is not a locale we ship", () => {
    withLanguage("ru")
    window.history.replaceState({}, "", "/?locale=klingon")
    expect(detectLocale()).toBe("ru")
  })

  it("matches a full code, script subtag and all", () => {
    withLanguage("sr-Cyrl")
    expect(detectLocale()).toBe("sr-Cyrl")
  })

  it("sends a scriptless Serbian to Latin rather than to English", () => {
    for (const code of ["sr", "sr-RS", "sr-ME"]) {
      withLanguage(code)
      expect(detectLocale()).toBe("sr-Latn")
    }
  })

  it("falls back to the primary subtag for a region variant", () => {
    withLanguage("uk-UA")
    expect(detectLocale()).toBe("uk")
    withLanguage("en-US")
    expect(detectLocale()).toBe("en")
  })

  it("falls back to English for a language we do not ship", () => {
    withLanguage("ja-JP")
    expect(detectLocale()).toBe("en")
  })

  it("resolves every locale we ship to itself", () => {
    for (const loc of SUPPORTED_LOCALES) {
      withLanguage(loc)
      expect(detectLocale()).toBe(loc)
    }
  })
})

describe("plural rules", () => {
  // The slot order is one | few | many; a rule returning anything outside
  // 0..2 throws inside the render rather than falling back to English.
  const east = PLURAL_RULES.ru

  it.each([
    [1, 0],
    [21, 0],
    [101, 0],
    [2, 1],
    [4, 1],
    [23, 1],
    [0, 2],
    [5, 2],
    [11, 2],
    [12, 2],
    [14, 2],
    [111, 2],
  ])("east-slavic picks slot %i → %i", (n, slot) => {
    expect(east(n)).toBe(slot)
  })

  it.each([
    [1, 0],
    [2, 1],
    [22, 1],
    [4, 1],
    [0, 2],
    [5, 2],
    [12, 2],
    [14, 2],
    // Polish reserves `one` for exactly 1, so 21 is `many` where East-Slavic
    // would call it `one`.
    [21, 2],
  ])("polish picks slot %i → %i", (n, slot) => {
    expect(PLURAL_RULES.pl(n)).toBe(slot)
  })

  it("treats a negative count as its magnitude", () => {
    expect(east(-1)).toBe(0)
    expect(PLURAL_RULES.pl(-1)).toBe(0)
  })

  it("never returns a slot the three-form strings do not have", () => {
    for (const rule of Object.values(PLURAL_RULES)) {
      for (let n = 0; n < 250; n++) {
        const slot = rule(n)
        expect(slot).toBeGreaterThanOrEqual(0)
        expect(slot).toBeLessThanOrEqual(2)
      }
    }
  })

  it("shares one rule across the East-Slavic and Serbian locales", () => {
    expect(PLURAL_RULES.uk).toBe(east)
    expect(PLURAL_RULES["sr-Latn"]).toBe(east)
    expect(PLURAL_RULES["sr-Cyrl"]).toBe(east)
  })
})
