import { describe, it, expect } from "vitest"
import { pickSeedLanguages } from "../localeLanguageSeed.js"

describe("pickSeedLanguages", () => {
  it("constrains the reduced locale to the catalog", () => {
    expect(pickSeedLanguages("uk", ["ru", "en"])).toEqual({ languages: ["ru"], fromDb: true })
  })

  it("falls back to en when the catalog has no matching language", () => {
    expect(pickSeedLanguages("uk", ["en"])).toEqual({ languages: ["en"], fromDb: true })
  })

  it("marks a seed derived without the catalog as a guess", () => {
    expect(pickSeedLanguages("uk", [])).toEqual({ languages: ["ru"], fromDb: false })
  })
})
