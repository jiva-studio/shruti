import { beforeAll, describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"

import { PLURAL_RULES, SUPPORTED_LOCALES, i18n, loadLocaleMessages } from "../index.js"

/**
 * How many `|`-separated forms every plural string carries, per locale.
 *
 * `localeKeyParity.test.ts` deliberately dedupes placeholders before comparing
 * them, precisely so a three-form Russian string can mirror a two-form English
 * one — which means the form COUNT is compared nowhere. That is the one thing
 * about a plural string that can crash the app: `index.ts` registers a
 * three-form rule for ru, uk, sr-Latn, sr-Cyrl and pl, the rule returns 0..2 unconditionally, and
 * vue-i18n does not clamp the index against the number of forms present. A
 * translator dropping the `many` form does not degrade to English — it throws
 * inside the render, in production builds too (see the characterization test
 * below, which pins that behaviour so a vue-i18n upgrade that starts clamping
 * gets noticed rather than silently making this guard moot).
 *
 * The convention this file enforces: two-form locales are `one | other`, the
 * five with a registered rule are `one | few | many`. The `zero | one | other`
 * shape is NOT used — it makes slot 0 mean "zero" in one locale and "one" in
 * another under the same key, which is exactly how `search.search` came to
 * render a bare "Поиск" for counts 1, 21, 31…
 */

/** Leaf path → string, arrays indexed. Same flattening as localeKeyParity. */
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

/** Forms in a vue-i18n plural string. A string without `|` is not a plural. */
function forms(value: string): number {
  return value.split("|").length
}

const THREE_FORM_LOCALES = SUPPORTED_LOCALES.filter((l) => l in PLURAL_RULES)
const TWO_FORM_LOCALES = SUPPORTED_LOCALES.filter((l) => !(l in PLURAL_RULES))

describe("plural arity", () => {
  const bundles = new Map<string, Flat>()

  beforeAll(async () => {
    await Promise.all(SUPPORTED_LOCALES.map(loadLocaleMessages))
    const messages = i18n.global.messages.value as Record<string, unknown>
    for (const locale of SUPPORTED_LOCALES) {
      bundles.set(locale, flatten(messages[locale], "", new Map()))
    }
  })

  it("knows which locales carry a three-form rule", () => {
    expect([...THREE_FORM_LOCALES].sort()).toEqual(["pl", "ru", "sr-Cyrl", "sr-Latn", "uk"])
    expect(TWO_FORM_LOCALES).toContain("en")
  })

  // The reason the assertions below are worth having at all. vue-i18n 11.4.0
  // hands the rule's return value straight to the form list; an index past the
  // end is not clamped, it is a type error thrown during render.
  it("throws when a three-form rule indexes a two-form string", () => {
    const probe = createI18n({
      legacy: false,
      locale: "ru",
      fallbackLocale: "en",
      pluralRules: { ru: PLURAL_RULES.ru! },
      messages: { ru: { k: "трек | трека" }, en: { k: "track | tracks" } },
    })
    expect(probe.global.t("k", 1)).toBe("трек")
    expect(probe.global.t("k", 2)).toBe("трека")
    // `many` — index 2, which the two-form string does not have.
    expect(() => probe.global.t("k", 5)).toThrow()
  })

  it.each(THREE_FORM_LOCALES)("%s carries exactly three forms on every plural key", (locale) => {
    const wrong = [...bundles.get(locale)!.entries()]
      .filter(([, value]) => value.includes("|"))
      .filter(([, value]) => forms(value) !== 3)
      .map(([key, value]) => `${key}: ${forms(value)} forms — ${value}`)
    expect(wrong).toEqual([])
  })

  it.each(TWO_FORM_LOCALES)("%s carries exactly two forms on every plural key", (locale) => {
    // A third form here is the `zero | one | other` shape. Nothing selects it
    // (no rule is registered for these locales that returns a zero index), and
    // its presence means slot 0 holds a zero-form here while the five
    // rule-carrying locales read the same slot as `one`.
    const wrong = [...bundles.get(locale)!.entries()]
      .filter(([, value]) => value.includes("|"))
      .filter(([, value]) => forms(value) !== 2)
      .map(([key, value]) => `${key}: ${forms(value)} forms — ${value}`)
    expect(wrong).toEqual([])
  })

  it.each(SUPPORTED_LOCALES.filter((l) => l !== "en"))(
    "%s keeps every key en pluralises plural",
    (locale) => {
      // Arity differs by locale on purpose, so it cannot be compared across
      // them — but plural-ness can. A translator who collapses a plural to a
      // single form crashes the rule-carrying locales and silently drops the
      // other form everywhere else.
      const reference = bundles.get("en")!
      const collapsed = [...reference.entries()]
        .filter(([, value]) => value.includes("|"))
        .map(([key]) => key)
        .filter((key) => {
          const value = bundles.get(locale)!.get(key)
          return value !== undefined && !value.includes("|")
        })
      expect(collapsed).toEqual([])
    }
  )
})
