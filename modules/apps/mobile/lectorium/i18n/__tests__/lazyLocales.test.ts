import { afterEach, describe, expect, it, vi } from "vitest"

import de from "../bundles/de.js"
import en from "../bundles/en.js"
import ru from "../bundles/ru.js"

/** A key that reads differently in en / ru / de, so "which bundle is live"
 *  is observable. Compared against the bundles themselves rather than
 *  hard-coded copy, so a wording change doesn't fail this suite. */
const KEY = "settings.groups.subscription"

/**
 * The i18n module owns process-wide state (the vue-i18n instance, the set of
 * locales already hydrated) and half of what is under test happens at
 * module-evaluation time — so every case re-imports it fresh, under the
 * device language it wants.
 */
async function freshI18n(deviceLanguage: string) {
  vi.resetModules()
  vi.stubGlobal("navigator", { language: deviceLanguage })
  return await import("../index.js")
}

function loadedLocales(messages: object): string[] {
  return Object.keys(messages).sort()
}

describe("lazy locale bundles", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders the boot locale without awaiting anything", async () => {
    const { i18n } = await freshI18n("en-US")

    expect(i18n.global.locale.value).toBe("en")
    expect(i18n.global.t(KEY)).toBe(en.settings.groups.subscription)
  })

  it("ships only en in the entry chunk", async () => {
    const { i18n } = await freshI18n("en-US")

    expect(loadedLocales(i18n.global.messages.value)).toEqual(["en"])
  })

  it("renders a non-en boot locale in en until its chunk resolves", async () => {
    const { i18n, bootLocaleReady } = await freshI18n("ru-RU")

    expect(i18n.global.locale.value).toBe("ru")
    expect(i18n.global.t(KEY)).toBe(en.settings.groups.subscription)

    await bootLocaleReady

    expect(i18n.global.t(KEY)).toBe(ru.settings.groups.subscription)
  })

  it("loads the messages before flipping the active locale", async () => {
    const { i18n, setLocale } = await freshI18n("en-US")

    const switching = setLocale("de")
    // Mid-switch the UI must still be a consistent en, not a `de` with no
    // messages behind it.
    expect(i18n.global.locale.value).toBe("en")

    await switching

    expect(i18n.global.locale.value).toBe("de")
    expect(i18n.global.t(KEY)).toBe(de.settings.groups.subscription)
  })

  it("falls back to en for a key the active locale is missing", async () => {
    const { i18n, setLocale } = await freshI18n("en-US")
    i18n.global.mergeLocaleMessage("en", { fallbackProbe: { key: "English only" } })

    await setLocale("ru")

    expect(i18n.global.t("fallbackProbe.key")).toBe("English only")
  })

  it("never loads a locale the user did not select", async () => {
    const { i18n, setLocale } = await freshI18n("en-US")

    await setLocale("ru")
    await setLocale("hi")

    expect(loadedLocales(i18n.global.messages.value)).toEqual(["en", "hi", "ru"])
  })
})
