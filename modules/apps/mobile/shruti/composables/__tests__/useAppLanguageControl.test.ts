import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import { useAppLanguageControl } from "../useAppLanguageControl.js"
import { currentLocale, setLocale } from "@shruti/i18n/index.js"

vi.mock("@shruti/i18n/index.js", () => ({
  SUPPORTED_LOCALES: ["en", "ru", "de", "uk"],
  currentLocale: vi.fn(() => "en"),
  setLocale: vi.fn(async () => "applied"),
}))

const mockedSetLocale = vi.mocked(setLocale)
const mockedCurrentLocale = vi.mocked(currentLocale)

/** Drain the setter's fire-and-forget promise chain. */
const settle = () => Promise.resolve().then(() => undefined)

describe("useAppLanguageControl", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedCurrentLocale.mockReturnValue("en")
    mockedSetLocale.mockResolvedValue("applied")
  })

  it("does not move the setting until the chunk is live", async () => {
    const appLanguage = ref("en")
    const model = useAppLanguageControl(appLanguage)

    model.value = "ru"

    // Writing the setting synchronously is what put half the screen in the new
    // language (dictionary names, dates) while the rest waited on the chunk.
    expect(appLanguage.value).toBe("en")
    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
  })

  it("moves the setting once the switch has been applied", async () => {
    mockedCurrentLocale.mockReturnValue("ru")
    const appLanguage = ref("en")
    const model = useAppLanguageControl(appLanguage)

    model.value = "ru"
    await settle()

    expect(appLanguage.value).toBe("ru")
    expect(model.value).toBe("ru")
  })

  it("leaves the setting where it was when the chunk fails, and says so", async () => {
    mockedSetLocale.mockResolvedValue("failed")
    const appLanguage = ref("en")
    const onFailure = vi.fn()
    const model = useAppLanguageControl(appLanguage, onFailure)

    model.value = "de"
    await settle()

    // Nothing is persisted, so the mismatch cannot survive a restart either.
    expect(appLanguage.value).toBe("en")
    expect(onFailure).toHaveBeenCalledWith("de")
  })

  it("does not write a superseded pick over the one that won", async () => {
    mockedSetLocale.mockResolvedValue("superseded")
    mockedCurrentLocale.mockReturnValue("ru")
    const appLanguage = ref("ru")
    const model = useAppLanguageControl(appLanguage)

    model.value = "uk"
    await settle()

    expect(appLanguage.value).toBe("ru")
  })

  it("ignores an unsupported code", async () => {
    const model = useAppLanguageControl(ref("en"))

    model.value = "klingon"
    await settle()

    expect(mockedSetLocale).not.toHaveBeenCalled()
  })

  it("forwards a re-pick of the current language, which cancels a pending one", async () => {
    // Picking Українська then changing your mind back to Русский has to reach
    // `setLocale`, or the in-flight uk chunk is never marked superseded and
    // flips the UI when it lands.
    const model = useAppLanguageControl(ref("ru"))

    model.value = "ru"
    await settle()

    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
  })
})
