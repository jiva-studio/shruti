import { afterEach, describe, expect, it, vi } from "vitest"

import de from "../bundles/de.js"
import en from "../bundles/en.js"
import ru from "../bundles/ru.js"
import uk from "../bundles/uk.js"

/**
 * The lazy-locale path's failure and concurrency behaviour (issues #1605,
 * #1606). Companion to `lazyLocales.test.ts`, which covers the happy path.
 *
 * A locale chunk is a real dynamic import, so "the chunk 404s" and "the chunk
 * is still on the wire" are both expressed by mocking the bundle module the
 * `import.meta.glob` in `../index.ts` resolves to. Module-level state (the
 * vue-i18n instance, the loaded set, the boot promise) means every case
 * re-imports the module fresh.
 */

/** A key that reads differently in en / ru / de / uk, so "which bundle is
 *  live" is observable without hard-coding copy. */
const KEY = "settings.groups.subscription"

const MOCKED = ["../bundles/de.js", "../bundles/ru.js", "../bundles/uk.js"]

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function freshI18n(deviceLanguage: string) {
  vi.resetModules()
  vi.stubGlobal("navigator", { language: deviceLanguage })
  return await import("../index.js")
}

describe("boot locale failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const path of MOCKED) vi.doUnmock(path)
  })

  it("resolves bootLocaleReady even when the boot chunk never arrives", async () => {
    vi.doMock("../bundles/ru.js", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })

    const { bootLocaleReady, i18n } = await freshI18n("ru-RU")

    // The one contract main.ts depends on: awaiting this can never abort
    // startup, so the mount still happens and the app is not a blank WebView.
    await expect(bootLocaleReady).resolves.toBeUndefined()
    // Nothing is stranded half-applied — every key still renders, in en.
    expect(i18n.global.t(KEY)).toBe(en.settings.groups.subscription)
  })

  it("rejects a locale that has no bundle instead of silently doing nothing", async () => {
    const { loadLocaleMessages } = await freshI18n("en-US")

    // `SUPPORTED_LOCALES` and `bundles/` can drift; a locale added to one and
    // not the other used to resolve successfully and apply nothing.
    await expect(
      loadLocaleMessages("xx" as unknown as Parameters<typeof loadLocaleMessages>[0])
    ).rejects.toThrow(/bundle/)
  })
})

describe("locale switch race", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const path of MOCKED) vi.doUnmock(path)
  })

  it("leaves the UI in the language picked LAST when an earlier chunk lands later", async () => {
    const uaChunk = deferred()
    vi.doMock("../bundles/uk.js", async () => {
      await uaChunk.promise
      return { default: uk }
    })

    const { i18n, setLocale, bootLocaleReady } = await freshI18n("ru-RU")
    await bootLocaleReady
    expect(i18n.global.t(KEY)).toBe(ru.settings.groups.subscription)

    // Pick Українська — its chunk goes on the wire — then change your mind
    // within the RTT and pick Русский, which is already resident.
    const slow = setLocale("uk")
    const fast = setLocale("ru")

    await expect(fast).resolves.toBe("applied")
    expect(i18n.global.locale.value).toBe("ru")

    // The uk chunk finally lands. It must not flip a UI the user has since
    // moved off, leaving the setting reading ru and the screen Ukrainian.
    uaChunk.resolve()
    await expect(slow).resolves.toBe("superseded")

    expect(i18n.global.locale.value).toBe("ru")
    expect(i18n.global.t(KEY)).toBe(ru.settings.groups.subscription)
  })

  it("still applies a slow chunk when nothing overtook it", async () => {
    const deChunk = deferred()
    vi.doMock("../bundles/de.js", async () => {
      await deChunk.promise
      return { default: de }
    })

    const { i18n, setLocale } = await freshI18n("en-US")

    const switching = setLocale("de")
    expect(i18n.global.locale.value).toBe("en")

    deChunk.resolve()
    await expect(switching).resolves.toBe("applied")
    expect(i18n.global.t(KEY)).toBe(de.settings.groups.subscription)
  })
})

describe("document language", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const path of MOCKED) vi.doUnmock(path)
  })

  /** `index.html` hardcodes `lang="en"`; the screen reader reads that, not the
   *  rendered copy, so it has to follow the UI language (#1607). */
  function stubDocument(): { lang: string } {
    const documentElement = { lang: "en" }
    vi.stubGlobal("document", { documentElement })
    return documentElement
  }

  it("stamps the boot locale on <html lang>", async () => {
    const documentElement = stubDocument()

    const { bootLocaleReady } = await freshI18n("de-DE")
    await bootLocaleReady

    expect(documentElement.lang).toBe("de")
  })

  it("follows a language switch", async () => {
    const documentElement = stubDocument()

    const { setLocale } = await freshI18n("en-US")
    // A script subtag has to survive intact — `sr` alone picks the wrong voice.
    expect(await setLocale("sr-Latn")).toBe("applied")

    expect(documentElement.lang).toBe("sr-Latn")
  })

  it("leaves it alone when the switch never applies", async () => {
    const documentElement = stubDocument()
    vi.doMock("../bundles/de.js", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })

    const { setLocale } = await freshI18n("en-US")
    expect(await setLocale("de")).toBe("failed")

    // The UI still renders en, so announcing German would be a lie.
    expect(documentElement.lang).toBe("en")
  })
})

describe("locale switch failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const path of MOCKED) vi.doUnmock(path)
  })

  it("reports the failure and leaves the UI language untouched", async () => {
    vi.doMock("../bundles/de.js", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })

    const { i18n, setLocale } = await freshI18n("en-US")

    // Never rejects — the caller is a watcher / a picker handler, and an
    // escaping rejection is what made this an unhandled promise before.
    await expect(setLocale("de")).resolves.toBe("failed")
    expect(i18n.global.locale.value).toBe("en")
    expect(i18n.global.t(KEY)).toBe(en.settings.groups.subscription)
  })

  it("recovers on a later successful switch", async () => {
    vi.doMock("../bundles/de.js", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })

    const { i18n, setLocale } = await freshI18n("en-US")

    expect(await setLocale("de")).toBe("failed")
    expect(await setLocale("ru")).toBe("applied")
    expect(i18n.global.t(KEY)).toBe(ru.settings.groups.subscription)
  })
})
