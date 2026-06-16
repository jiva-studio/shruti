/**
 * Single source of truth for which locales and device form factors the
 * screenshot pipeline produces. Everything else — Playwright projects, the
 * capture spec, fixture generation, and framing — derives from here, so adding
 * a language or a device is a one-line change.
 *
 * To add a UI locale:
 *   1. append it to CAPTURE_LOCALES (must be one of the app's SUPPORTED_LOCALES
 *      in modules/apps/mobile/lectorium/i18n/index.ts),
 *   2. add its headlines to frame/titles.json,
 *   3. generate its user.db fixture (`npm run generate-user-fixture`).
 */

/** UI locales to capture. Subset of the app's SUPPORTED_LOCALES. */
export const CAPTURE_LOCALES = ["en", "ru"] as const
export type CaptureLocale = (typeof CAPTURE_LOCALES)[number]

/**
 * Track audio + transcripts + outlines exist only in `en` and `ru`. Map any UI
 * locale to the content language whose demo lecture / library filter we use; UI
 * locales without their own audio fall back to English content (the same way
 * the app's localized-name resolver falls back at runtime).
 */
export function contentLanguageFor(locale: string): "en" | "ru" {
  return locale === "ru" ? "ru" : "en"
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
  { code: "iphone67", width: 430, height: 932, dpr: 3 }, // App Store 6.7" → 1290×2796
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
