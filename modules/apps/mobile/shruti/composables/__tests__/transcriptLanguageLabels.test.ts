import { describe, expect, it } from "vitest"
import { languageFlag, languageLabel } from "../transcriptLanguageLabels.js"

describe("languageLabel", () => {
  it("names a language the way its chip does", () => {
    expect(languageLabel("ru")).toBe("RU")
  })
})

describe("languageFlag", () => {
  it("maps a corpus language to its flag", () => {
    expect(languageFlag("uk")).toBe("🇺🇦")
  })

  it("accepts a code in any case", () => {
    expect(languageFlag("EN")).toBe("🇬🇧")
  })

  it("has no flag for an unmapped language", () => {
    expect(languageFlag("sr-Latn")).toBeUndefined()
  })
})
