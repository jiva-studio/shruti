/**
 * Which locales and device form factors the screenshot pipeline produces.
 * The locale list is NOT defined here — it's derived from the shared store
 * registry (modules/apps/mobile/store-locales.json), the single source of
 * truth that fastlane reads too. Everything else (Playwright projects, the
 * capture spec, fixture generation, framing) derives from this module.
 *
 * To add a UI locale to the stores + screenshots:
 *   1. add an entry to modules/apps/mobile/store-locales.json (the locale must
 *      be one of SUPPORTED_LOCALES in lectorium/i18n/index.ts),
 *   2. add its headlines to frame/titles.json (or run `npm run translate-titles`),
 *   3. generate its user.db fixture (`npm run generate-user-fixture`).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** One store registry entry (see store-locales.json `$comment`). */
export interface StoreLocale {
  /** Google Play locale code, or null if not published on Play. */
  play: string | null
  /** App Store Connect locale code, or null if the store can't take it. */
  appStore: string | null
  /** Whether to generate marketing screenshots for this locale. */
  capture?: boolean
  /** Hand-authored copy that auto-translation must never overwrite. */
  canonical?: boolean
}

/** The shared store registry, keyed by app UI locale. */
export const STORE_LOCALES: Record<string, StoreLocale> = (() => {
  const registryPath = path.resolve(__dirname, "../../apps/mobile/store-locales.json")
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
    locales: Record<string, StoreLocale>
  }
  return raw.locales
})()

/** UI locales to capture screenshots for (registry entries with capture !== false). */
export const CAPTURE_LOCALES: string[] = Object.entries(STORE_LOCALES)
  .filter(([, v]) => v.capture !== false)
  .map(([k]) => k)

/** A UI locale string — the registry is data-driven, so this is just a string. */
export type CaptureLocale = string

/**
 * Track audio + transcripts + outlines exist only in `en` and `ru`. Map any UI
 * locale to the content language whose demo lecture / library filter we use; UI
 * locales without their own audio fall back to English content (the same way
 * the app's localized-name resolver falls back at runtime).
 */
export function contentLanguageFor(locale: string): "en" | "ru" {
  // Same East-Slavic collapse the app/web use (ru, uk → ru; everything else
  // → en). Mirrors @lib/domain reduceLocaleToContentLanguage.
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return base === "ru" || base === "uk" ? "ru" : "en"
}

/**
 * Browser locale (BCP-47) handed to Playwright for Intl formatting only. The
 * app's actual UI language comes from the `?locale=` query param, not this.
 */
const BCP47: Record<string, string> = { en: "en-US", ru: "ru-RU" }
export function localeTag(locale: string): string {
  return BCP47[locale] ?? locale
}

export interface DeviceSpec {
  /** Folder / project segment, e.g. `phone`. Never contains a dash. */
  code: string
  width: number
  height: number
  dpr: number
}

/** Store form factors. width × height × dpr → output PNG size. */
export const DEVICES: readonly DeviceSpec[] = [
  { code: "phone", width: 412, height: 892, dpr: 3 }, // Play phone → 1236×2676
  { code: "iphone69", width: 440, height: 956, dpr: 3 }, // App Store 6.9" → 1320×2868 (master iPhone size; auto-scales to 6.7"/6.5")
  { code: "ipad13", width: 1024, height: 1366, dpr: 2 }, // App Store iPad 13" → 2048×2732
  { code: "surfaceduo", width: 540, height: 720, dpr: 2.5 }, // Play large-screen → 1350×1800
]

/** Playwright project name: `${device}-${locale}`. */
export function projectName(device: string, locale: string): string {
  return `${device}-${locale}`
}

/**
 * Split a project name back into device + locale. Device codes never contain a
 * dash, so split on the FIRST dash — this keeps dashed locales like `sr-Latn`
 * intact.
 */
export function parseProject(name: string): { device: string; code: string } {
  const i = name.indexOf("-")
  return { device: name.slice(0, i), code: name.slice(i + 1) }
}
