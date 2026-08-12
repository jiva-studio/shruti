import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

import { APP_LANGUAGE_KEY, applyStoredAppLanguage, useAppLanguage } from "../useAppLanguage.js"
import { __resetStoredAppLanguageForTests } from "../appLanguageApplied.js"
import { useLocaleSync } from "../useLocaleSync.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { currentLocale, detectLocale, setLocale } from "@lectorium/i18n/index.js"

/**
 * The cold-start language flash (#1742).
 *
 * `main.ts` applies the stored UI language before mount, so the first paint is
 * in the right language. But `useConfig` seeds its ref synchronously and
 * hydrates from storage asynchronously, and App.vue's `useLocaleSync` runs
 * `immediate: true` on that ref. On a Russian-speaking user's English-locale
 * phone the un-hydrated seed is `en`, so the immediate run undoes what startup
 * just did — `ru`, `en`, then `ru` again once hydration lands tens of ms later.
 *
 * Reproduced here as the real sequence rather than through the DOM: the seed
 * value and the immediate watcher run are the whole mechanism, and both are
 * observable without mounting anything.
 */

vi.mock("@lectorium/i18n/index.js", () => ({
  SUPPORTED_LOCALES: ["en", "ru", "de"],
  detectLocale: vi.fn(() => "en"),
  currentLocale: vi.fn(() => "en"),
  setLocale: vi.fn(async () => "applied"),
}))

// The real binder would drag the composition root in. This stand-in keeps the
// one property that matters: `initial` is what the ref holds until hydration.
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: vi.fn((_key: string, initial: unknown) => ref(initial)),
}))

const mockedSetLocale = vi.mocked(setLocale)
const mockedCurrentLocale = vi.mocked(currentLocale)
const mockedDetectLocale = vi.mocked(detectLocale)
const mockedUseConfig = vi.mocked(useConfig)

function fakePreferences(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

/** Let the watcher fire and its fire-and-forget promise chain settle. */
async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe("cold-start locale flash", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStoredAppLanguageForTests()
    mockedDetectLocale.mockReturnValue("en")
    mockedCurrentLocale.mockReturnValue("en")
    mockedSetLocale.mockResolvedValue("applied")
  })

  it("does not re-apply the device locale after startup applied the stored one", async () => {
    // Phone in English, Русский stored. This is what `main.ts` does before mount.
    await applyStoredAppLanguage(fakePreferences({ [APP_LANGUAGE_KEY]: '"ru"' }))
    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
    mockedCurrentLocale.mockReturnValue("ru")

    // …and this is App.vue, on a ref `useConfig` has not hydrated yet.
    mockedSetLocale.mockClear()
    useLocaleSync(ref("en"))
    await settle()

    expect(mockedSetLocale).not.toHaveBeenCalled()
  })

  it("still applies the ref's language on the first launch, with nothing stored", async () => {
    // No stored choice — nothing ran before mount, so the immediate run is the
    // only thing that puts the language on screen. It must stay.
    await applyStoredAppLanguage(fakePreferences())

    useLocaleSync(ref("ru"))
    await settle()

    expect(mockedSetLocale).toHaveBeenCalledWith("ru")
  })

  it("still follows a later change to the setting", async () => {
    await applyStoredAppLanguage(fakePreferences({ [APP_LANGUAGE_KEY]: '"ru"' }))
    mockedCurrentLocale.mockReturnValue("ru")
    mockedSetLocale.mockClear()

    const appLanguage = ref("ru")
    useLocaleSync(appLanguage)
    await settle()
    expect(mockedSetLocale).not.toHaveBeenCalled()

    // Hydration landing, or the user picking a language in Settings.
    appLanguage.value = "de"
    await settle()
    expect(mockedSetLocale).toHaveBeenCalledWith("de")
  })

  it("seeds the shared language ref from the live locale, not the device one", async () => {
    // Every other consumer reads this ref too — `repositories()` passes it as
    // `getActiveLanguage`, the chat store as the answer language. Seeding it
    // from the device locale hands all of them the wrong language for as long
    // as hydration takes.
    mockedCurrentLocale.mockReturnValue("ru")
    mockedDetectLocale.mockReturnValue("en")

    useAppLanguage()

    expect(mockedUseConfig).toHaveBeenCalledWith(APP_LANGUAGE_KEY, "ru")
  })
})
