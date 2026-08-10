import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

import { useLocaleSync } from "../useLocaleSync.js"
import { currentLocale, setLocale } from "@shruti/i18n/index.js"

vi.mock("@shruti/i18n/index.js", () => ({
  SUPPORTED_LOCALES: ["en", "ru", "de"],
  currentLocale: vi.fn(() => "en"),
  setLocale: vi.fn(async () => "applied"),
}))

const mockedSetLocale = vi.mocked(setLocale)
const mockedCurrentLocale = vi.mocked(currentLocale)

/** Let the watcher fire and its fire-and-forget promise chain settle. */
async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe("useLocaleSync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedCurrentLocale.mockReturnValue("en")
    mockedSetLocale.mockResolvedValue("applied")
  })

  it("applies the persisted language immediately", async () => {
    useLocaleSync(ref("ru"))
    await settle()

    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
  })

  it("ignores a value that is not a supported locale", async () => {
    useLocaleSync(ref("klingon"))
    await settle()

    expect(mockedSetLocale).not.toHaveBeenCalled()
  })

  it("rolls the setting back to the live language when the chunk fails", async () => {
    // The stored preference says Deutsch; its chunk is gone (hashes rotated by
    // a web deploy). The UI stays English — so the setting must stop claiming
    // otherwise, or the picker lies about it on every launch from here on.
    mockedSetLocale.mockResolvedValue("failed")
    const appLanguage = ref("de")

    useLocaleSync(appLanguage)
    await settle()

    expect(appLanguage.value).toBe("en")
  })

  it("leaves the setting alone when the user has moved on mid-failure", async () => {
    mockedSetLocale.mockImplementation(async (locale) => (locale === "de" ? "failed" : "applied"))
    const appLanguage = ref("de")

    useLocaleSync(appLanguage)
    appLanguage.value = "ru"
    await settle()

    // The rollback belongs to the value that failed, not to whatever the ref
    // holds by the time the failure lands.
    expect(appLanguage.value).toBe("ru")
  })

  it("does not touch the setting on a successful switch", async () => {
    const appLanguage = ref("ru")

    useLocaleSync(appLanguage)
    await settle()

    expect(appLanguage.value).toBe("ru")
  })
})
