import { describe, it, expect } from "vitest"
import trackViewSource from "../TrackView.vue?raw"

const LOCALES = [
  "bn",
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "hu",
  "it",
  "pl",
  "pt",
  "ru",
  "sr-Cyrl",
  "sr-Latn",
  "uk",
] as const

const bundles = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../i18n/locales/*/*.ts"
)

// `lastIndexOf` — the view nests an inner `<template v-else-if>`, so the first
// closing tag is not the end of the root block.
const template = trackViewSource.slice(
  trackViewSource.indexOf("<template>"),
  trackViewSource.lastIndexOf("</template>")
)

/** Template text that survives once tags and `{{ … }}` bindings are removed. */
function literalTextNodes(html: string): string[] {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "")
    .replace(/<[^>]*>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\p{L}/u.test(line))
}

function translationKeys(html: string): string[] {
  return [...html.matchAll(/\$t\(\s*["']([^"']+)["']/g)].map((m) => m[1])
}

async function resolveKey(locale: string, key: string): Promise<unknown> {
  const [namespace, ...path] = key.split(".")
  const load = bundles[`../../../i18n/locales/${locale}/${namespace}.ts`]
  if (!load) return undefined
  const bundle = (await load()).default
  return path.reduce<unknown>(
    (node, segment) =>
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    bundle
  )
}

describe("TrackView i18n", () => {
  it("renders no hardcoded text", () => {
    expect(literalTextNodes(template)).toEqual([])
  })

  it("references at least the title, play and loading keys", () => {
    expect(translationKeys(template)).toEqual(
      expect.arrayContaining(["track.title", "track.play", "track.loading"])
    )
  })

  it("does not label the play button with the generic OK key", () => {
    expect(translationKeys(template)).not.toContain("app.ok")
  })

  it.each(LOCALES)("resolves every key in %s", async (locale) => {
    for (const key of translationKeys(template)) {
      const value = await resolveKey(locale, key)
      expect(value, `${locale} is missing ${key}`).toBeTypeOf("string")
      expect(value, `${locale} has an empty ${key}`).not.toBe("")
    }
  })

  it.each(LOCALES.filter((l) => l !== "en"))("translates the keys in %s", async (locale) => {
    for (const key of translationKeys(template)) {
      expect(await resolveKey(locale, key), `${locale} copies the English ${key}`).not.toBe(
        await resolveKey("en", key)
      )
    }
  })
})
