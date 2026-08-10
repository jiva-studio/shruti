import { beforeAll, describe, expect, it } from "vitest"

import { SUPPORTED_LOCALES, i18n, loadLocaleMessages } from "../index.js"

/**
 * Structural parity of every shipped locale against `en`, across every
 * namespace — not a hand-picked list of keys.
 *
 * `fallbackLocale: "en"` means a locale missing a key renders the English
 * string rather than the raw key, so a gap is invisible to a smoke test and
 * to the user's eye until a whole screen reads English inside a translated
 * UI. That is exactly how the personal-library surface, the email sign-in
 * modal and the first-run paywall shipped untranslated to twelve locales
 * (#1607): the only parity assertion in the suite compared statically
 * referenced keys against `en` alone.
 *
 * `translationKeys.test.ts` asks "is every key the code uses defined?".
 * This asks "does every locale define what `en` defines?" — the direction
 * that catches a namespace someone extended in `en` and `ru` only.
 */

/** The locale every other one is measured against. */
const REFERENCE = "en"

const OTHERS = SUPPORTED_LOCALES.filter((locale) => locale !== REFERENCE)

/** Keys whose row renders in a single locale, so `en` has nothing to mirror.
 *  Anything else absent from `en` is drift, not intent. */
const LOCALE_ONLY: Record<string, string> = {
  "settings.contacts.vk.title": "ru",
  "settings.contacts.vk.description": "ru",
  "settings.contacts.telegram.title": "ru",
  "settings.contacts.telegram.description": "ru",
}

/** Leaf path → string. Arrays are indexed (`chat.suggestions[3]`) so a
 *  truncated list reads as missing keys rather than silently passing. */
type Flat = Map<string, string>

function flatten(node: unknown, prefix: string, out: Flat): Flat {
  if (typeof node === "string") {
    out.set(prefix, node)
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

/** The distinct vue-i18n named-parameter slots (`{email}`, `{seconds}`) and
 *  literal escapes (`{'@'}`) a string uses. A translation that drops one
 *  renders a sentence with a hole in it; one that invents one renders the
 *  brace verbatim. Deduped because a `|`-separated plural repeats its slots
 *  once per form, and the Slavic locales carry three forms where `en` has two. */
function placeholders(value: string): string {
  return [...new Set(value.match(/\{[^{}]*\}/g) ?? [])].sort().join(",")
}

describe("locale key parity", () => {
  const bundles = new Map<string, Flat>()

  beforeAll(async () => {
    // Only `en` ships in the entry chunk; every other locale is a lazy import.
    await Promise.all(SUPPORTED_LOCALES.map(loadLocaleMessages))
    const messages = i18n.global.messages.value as Record<string, unknown>
    for (const locale of SUPPORTED_LOCALES) {
      bundles.set(locale, flatten(messages[locale], "", new Map()))
    }
  })

  it("compares against a fully loaded reference bundle", () => {
    expect(bundles.get(REFERENCE)!.size).toBeGreaterThan(600)
    expect(OTHERS).toHaveLength(13)
  })

  it.each(OTHERS)("%s defines every key en defines", (locale) => {
    const reference = bundles.get(REFERENCE)!
    const missing = [...reference.keys()].filter((key) => !bundles.get(locale)!.has(key))
    expect(missing).toEqual([])
  })

  it.each(OTHERS)("%s defines nothing en doesn't", (locale) => {
    const reference = bundles.get(REFERENCE)!
    const extra = [...bundles.get(locale)!.keys()].filter(
      (key) => !reference.has(key) && LOCALE_ONLY[key] !== locale
    )
    expect(extra).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)("%s has no blank strings", (locale) => {
    const blank = [...bundles.get(locale)!.entries()]
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key)
    expect(blank).toEqual([])
  })

  it.each(OTHERS)("%s keeps en's interpolation slots", (locale) => {
    const reference = bundles.get(REFERENCE)!
    const drifted = [...bundles.get(locale)!.entries()]
      .filter(([key, value]) => {
        const source = reference.get(key)
        if (source === undefined) return false
        return placeholders(source) !== placeholders(value)
      })
      .map(([key]) => key)
    expect(drifted).toEqual([])
  })

  it("resolves locale-only keys in their owning locale", () => {
    const missing = Object.entries(LOCALE_ONLY).filter(
      ([key, locale]) => !bundles.get(locale)!.has(key)
    )
    expect(missing).toEqual([])
  })
})
