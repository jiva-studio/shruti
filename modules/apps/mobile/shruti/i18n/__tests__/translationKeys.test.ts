import { beforeAll, describe, expect, it } from "vitest"

import { SUPPORTED_LOCALES, i18n, loadLocaleMessages } from "../index.js"

/** `t("a.b")` / `$t('a.b')` with a literal, dotted key. Template-literal and
 *  computed keys are deliberately out of reach — the guard only pins what it
 *  can resolve statically. */
const KEY_CALL = /(?<![A-Za-z0-9_$.])\$?t\(\s*(["'])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g

/** Keys whose rows render in one locale only, so an `en` string would be dead
 *  copy. Each one is asserted to exist in its owning locale below. */
const LOCALE_SCOPED: Record<string, string> = {
  "settings.contacts.vk.title": "ru",
  "settings.contacts.vk.description": "ru",
  "settings.contacts.telegram.title": "ru",
  "settings.contacts.telegram.description": "ru",
}

const sources = import.meta.glob("../../../{shruti,ui,usecases,infra}/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

function referencedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>()
  for (const [file, source] of Object.entries(sources)) {
    if (file.includes("/__tests__/") || file.includes("/i18n/locales/")) continue
    for (const match of source.matchAll(KEY_CALL)) {
      const key = match[2]
      const where = keys.get(key)
      if (where) where.push(file)
      else keys.set(key, [file])
    }
  }
  return keys
}

function lookup(locale: string, key: string): unknown {
  const messages = i18n.global.messages.value as Record<string, unknown>
  let node: unknown = messages[locale]
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

describe("translation keys", () => {
  const keys = referencedKeys()

  // Only `en` ships in the entry chunk; the coverage assertions below read
  // every locale, so pull them all in first.
  beforeAll(async () => {
    await Promise.all(SUPPORTED_LOCALES.map(loadLocaleMessages))
  })

  it("finds keys to check", () => {
    expect(keys.size).toBeGreaterThan(100)
  })

  it("resolves every statically referenced key in en", () => {
    const missing = [...keys.entries()]
      .filter(([key]) => !(key in LOCALE_SCOPED) && typeof lookup("en", key) !== "string")
      .map(([key, files]) => `${key} (${files[0]})`)
    expect(missing).toEqual([])
  })

  it("resolves locale-scoped keys in their owning locale", () => {
    const missing = Object.entries(LOCALE_SCOPED)
      .filter(([key, locale]) => typeof lookup(locale, key) !== "string")
      .map(([key, locale]) => `${key} (${locale})`)
    expect(missing).toEqual([])
  })

  // The toast copy behind "save citation as note" — the whole flow (in-flight,
  // success, failure) has to be translated everywhere, not just in en.
  // `actionNoteError` covers both saveCitationAsNote failures (empty text and
  // create-note-failed) and was missing from all 14 locales (#1478).
  // `smartLibrary.archive.off` is built from a template literal, so the static
  // scan above can't see it — and it is the only way to stop the sweep from
  // deleting downloaded audio (#1624).
  it.each([
    "chat.noteSaving",
    "chat.noteSaved",
    "chat.actionNoteError",
    "settings.smartLibrary.archive.off",
  ])("translates %s in every locale", (key) => {
    const missing = SUPPORTED_LOCALES.filter((locale) => {
      const value = lookup(locale, key)
      return typeof value !== "string" || value.trim() === ""
    })
    expect(missing).toEqual([])
  })
})
