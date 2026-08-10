import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  APP_LANGUAGE_KEY,
  applyStoredAppLanguage,
  readStoredAppLanguage,
} from "../useAppLanguage.js"
import { currentLocale, setLocale } from "@lectorium/i18n/index.js"

vi.mock("@lectorium/i18n/index.js", () => ({
  SUPPORTED_LOCALES: ["en", "ru", "de"],
  detectLocale: vi.fn(() => "en"),
  currentLocale: vi.fn(() => "en"),
  setLocale: vi.fn(async () => "applied"),
}))

// Only `useAppLanguage()` itself needs the config binder; pulling in the real
// one would drag the whole composition root into this suite.
vi.mock("@lectorium/composables/useConfig.js", () => ({ useConfig: vi.fn() }))

const mockedSetLocale = vi.mocked(setLocale)
const mockedCurrentLocale = vi.mocked(currentLocale)

function fakePreferences(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

describe("readStoredAppLanguage", () => {
  it("decodes the JSON payload useConfig writes", async () => {
    const prefs = fakePreferences({ [APP_LANGUAGE_KEY]: '"ru"' })

    await expect(readStoredAppLanguage(prefs)).resolves.toBe("ru")
  })

  it("accepts a bare code from an older build", async () => {
    const prefs = fakePreferences({ [APP_LANGUAGE_KEY]: "ru" })

    await expect(readStoredAppLanguage(prefs)).resolves.toBe("ru")
  })

  it("reports null for an absent or unsupported value", async () => {
    await expect(readStoredAppLanguage(fakePreferences())).resolves.toBeNull()
    await expect(
      readStoredAppLanguage(fakePreferences({ [APP_LANGUAGE_KEY]: '"klingon"' }))
    ).resolves.toBeNull()
  })
})

describe("applyStoredAppLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedCurrentLocale.mockReturnValue("en")
    mockedSetLocale.mockResolvedValue("applied")
  })

  it("applies the stored choice over the device locale", async () => {
    // Phone in English, Русский chosen. Without this the first paint is a full
    // English screen that swaps language a moment later.
    await applyStoredAppLanguage(fakePreferences({ [APP_LANGUAGE_KEY]: '"ru"' }))

    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
  })

  it("does nothing when there is no stored choice", async () => {
    await applyStoredAppLanguage(fakePreferences())

    expect(mockedSetLocale).not.toHaveBeenCalled()
  })

  it("does nothing when the stored choice is already live", async () => {
    mockedCurrentLocale.mockReturnValue("ru")

    await applyStoredAppLanguage(fakePreferences({ [APP_LANGUAGE_KEY]: '"ru"' }))

    expect(mockedSetLocale).not.toHaveBeenCalled()
  })

  it("rewrites the preference to the live language when the chunk fails", async () => {
    mockedSetLocale.mockResolvedValue("failed")
    const prefs = fakePreferences({ [APP_LANGUAGE_KEY]: '"de"' })

    await applyStoredAppLanguage(prefs)

    expect(prefs.store.get(APP_LANGUAGE_KEY)).toBe('"en"')
  })

  it("never rejects when preferences are unavailable", async () => {
    const prefs = {
      get: vi.fn(async () => {
        throw new Error("storage unavailable")
      }),
      set: vi.fn(async () => undefined),
    }

    await expect(applyStoredAppLanguage(prefs)).resolves.toBeUndefined()
  })
})
