import { createI18n } from "vue-i18n"

import en from "./bundles/en.js"

export const SUPPORTED_LOCALES = [
  "en",
  "ru",
  "uk",
  "sr-Latn",
  "sr-Cyrl",
  "es",
  "pt",
  "it",
  "de",
  "fr",
  "pl",
  "hu",
  "hi",
  "bn",
] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Marketing-site (shruti.app) locales that have their own localized
 *  legal pages. App locales outside this set fall back to English. */
const POLICY_SITE_LOCALES: Partial<Record<SupportedLocale, string>> = {
  ru: "ru",
  uk: "uk",
  "sr-Latn": "sr-latn",
  "sr-Cyrl": "sr-cyrl",
}

/** URL of the privacy policy on the marketing site for `locale`
 *  (web app src/pages/[lang]/privacy.astro). Single source of truth for the
 *  in-app Privacy Policy links (Settings + subscription paywall). */
export function privacyPolicyUrl(locale: string): string {
  const seg = POLICY_SITE_LOCALES[locale as SupportedLocale] ?? "en"
  return `https://shruti.app/${seg}/privacy`
}

/**
 * Pick a UI locale based on `navigator.language`. Sync — safe to call
 * at module load. On Capacitor's WebView `navigator.language` already
 * mirrors the OS locale, so this is enough for the initial i18n boot
 * and the `useAppLanguage` default. For the search-filter first-launch
 * seed we prefer {@link detectDeviceLocaleAsync}, which goes through
 * the native Device plugin and falls back to this on failure.
 */
export function detectLocale(): SupportedLocale {
  // `?locale=en|ru` overrides device locale — used by the screenshots pipeline
  // (modules/tools/screenshots) to capture each locale deterministically
  // without touching the Settings UI.
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("locale")
    if (fromQuery && (SUPPORTED_LOCALES as readonly string[]).includes(fromQuery)) {
      return fromQuery as SupportedLocale
    }
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en"
  return toSupportedLocale(nav)
}

/**
 * Asks the native Capacitor Device plugin for the device language; on
 * failure (e.g. plugin not registered, web environment without the
 * shim) falls back to {@link detectLocale}.
 *
 * The `?locale=` query override wins first — same precedence as
 * {@link detectLocale} — so the screenshots/e2e pipelines that pin a
 * locale via the URL stay authoritative over the device language.
 */
export async function detectDeviceLocaleAsync(): Promise<SupportedLocale> {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("locale")
    if (fromQuery && (SUPPORTED_LOCALES as readonly string[]).includes(fromQuery)) {
      return fromQuery as SupportedLocale
    }
  }
  try {
    const { Device } = await import("@capacitor/device")
    const { value } = await Device.getLanguageCode()
    return toSupportedLocale(value)
  } catch {
    return detectLocale()
  }
}

function toSupportedLocale(raw: string | null | undefined): SupportedLocale {
  const code = raw ?? "en"
  // Match the full code first — `sr-Latn` / `sr-Cyrl` carry a meaningful
  // script subtag, so stripping it would collapse both to `sr` and miss.
  if ((SUPPORTED_LOCALES as readonly string[]).includes(code)) {
    return code as SupportedLocale
  }
  // Serbian needs a script subtag to pick a bundle, but Capacitor's Device
  // plugin (and many OS locales) report a bare `sr` or a region variant
  // like `sr-RS` / `sr-ME` with no script. Default those to Latin — the
  // hand-authored bundle `sr-Cyrl` is transliterated from — rather than
  // letting them fall through to English.
  if (code === "sr" || code.startsWith("sr-")) {
    return "sr-Latn"
  }
  // Fall back to the primary subtag so region variants like `uk-UA` →
  // `uk` or `en-US` → `en` still resolve.
  const short = code.split("-")[0] as SupportedLocale
  return (SUPPORTED_LOCALES as readonly string[]).includes(short) ? short : "en"
}

/**
 * CLDR plural-category selector for East-Slavic languages (ru, uk) and
 * Serbian (sr): maps a count to the `one | few | many` slot order used by
 * the `|`-separated plural strings in those locales.
 *
 *   one  → index 0 — n % 10 == 1 and n % 100 != 11   (1, 21, 31, …)
 *   few  → index 1 — n % 10 in 2..4 and n % 100 not in 12..14  (2, 3, 4, …)
 *   many → index 2 — everything else (0, 5..20, 11..14, …)
 *
 * vue-i18n calls this with the resolved choice count; the return value is
 * the zero-based index into the choice list. Without it, vue-i18n applies
 * the default English binary rule and mis-selects every Slavic form.
 */
function slavicEastPluralRule(choice: number): number {
  const n = Math.abs(choice)
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 0 // one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1 // few
  return 2 // many
}

/**
 * CLDR plural-category selector for Polish — same `one | few | many` slot
 * order, but `one` is reserved for exactly 1 and the `few` band excludes
 * the 12..14 hundreds range differently from East-Slavic.
 *
 *   one  → index 0 — n == 1
 *   few  → index 1 — n % 10 in 2..4 and n % 100 not in 12..14
 *   many → index 2 — everything else
 */
function polishPluralRule(choice: number): number {
  const n = Math.abs(choice)
  if (n === 1) return 0 // one
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1 // few
  return 2 // many
}

/** Shape every locale bundle shares — `en` is the reference. */
type LocaleBundle = typeof en

/**
 * One lazily-imported chunk per locale (`./bundles/<locale>.ts`). `en` also
 * appears here, but it is statically imported above, so the bundler keeps it
 * in the entry chunk and this loader resolves to the copy already in memory.
 */
const BUNDLES = import.meta.glob<{ default: LocaleBundle }>("./bundles/*.ts")

const BOOT_LOCALE = detectLocale()

export const i18n = createI18n({
  legacy: false,
  locale: BOOT_LOCALE,
  fallbackLocale: "en",
  // Register CLDR plural-rule selectors for the locales whose `|`-separated
  // strings carry 3 forms (one/few/many). Locales absent from this map keep
  // vue-i18n's default English binary rule, which is correct for the
  // Germanic / Romance / two-form locales in the bundle.
  pluralRules: {
    ru: slavicEastPluralRule,
    uk: slavicEastPluralRule,
    "sr-Latn": slavicEastPluralRule,
    "sr-Cyrl": slavicEastPluralRule,
    pl: polishPluralRule,
  },
  // Only `en` is present at boot. It is both the fallback (so a key missing
  // from any locale still renders English rather than the raw key) and the
  // default for English devices, which therefore await nothing at all.
  messages: { en } as Record<SupportedLocale, LocaleBundle>,
})

const loaded = new Set<SupportedLocale>(["en"])

/**
 * Fetch `locale`'s chunk and hand it to vue-i18n. Idempotent and safe to call
 * concurrently — the second caller awaits the same in-flight import, because
 * the module registry dedupes it.
 *
 * Rejects when the chunk cannot be fetched (a hash rotated by a web deploy, a
 * dead radio). Every caller has to decide what that means for it; none may let
 * the rejection escape (issue #1605).
 */
export async function loadLocaleMessages(locale: SupportedLocale): Promise<void> {
  if (loaded.has(locale)) return
  const load = BUNDLES[`./bundles/${locale}.ts`]
  if (!load) throw new Error(`no message bundle for locale "${locale}"`)
  i18n.global.setLocaleMessage(locale, (await load()).default)
  loaded.add(locale)
}

/**
 * The boot locale's chunk, requested at module load so it downloads in
 * parallel with the rest of startup. `main.ts` awaits it before mounting, so
 * the first paint is already in the right language — and until it resolves
 * every key still renders, in `en`, never as a raw key.
 *
 * NEVER rejects. `main.ts` awaits this between `router.isReady()` and
 * `app.mount()`, so a rejection here used to abort startup outright and leave
 * the WebView blank once the native splash dismissed (issue #1605). The
 * resident `en` is a perfectly good first paint.
 */
export const bootLocaleReady: Promise<void> = loadLocaleMessages(BOOT_LOCALE).catch((e) => {
  console.warn("[i18n] boot locale chunk failed; starting in en", e)
})

/**
 * Outcome of a {@link setLocale} call:
 *  - `applied`    — messages loaded and the UI locale now reads `locale`.
 *  - `superseded` — a later call asked for a different locale while this one
 *    was still fetching, so this one deliberately did nothing.
 *  - `failed`     — the chunk could not be loaded; the UI locale is unchanged.
 */
export type SetLocaleResult = "applied" | "superseded" | "failed"

/** The locale of the most recent {@link setLocale} call, set synchronously so
 *  a slow chunk landing after a newer pick can tell it has been overtaken. */
let requested: SupportedLocale = BOOT_LOCALE

/**
 * Switch the UI language. Async because the messages have to arrive before
 * `locale.value` flips — flipping first would render the new locale against
 * an empty message set and flash English at the user mid-switch.
 *
 * Two switches in quick succession resolve in fetch order, not call order: the
 * second pick is usually already `loaded` and wins in a microtask while the
 * first is still on the wire. Flipping unconditionally after the await then
 * stranded the UI in the language the user did NOT pick (issue #1606), so a
 * call that has been overtaken reports `superseded` and applies nothing.
 */
export async function setLocale(locale: SupportedLocale): Promise<SetLocaleResult> {
  requested = locale
  try {
    await loadLocaleMessages(locale)
  } catch (e) {
    console.warn(`[i18n] locale "${locale}" failed to load`, e)
    return "failed"
  }
  if (requested !== locale) return "superseded"
  i18n.global.locale.value = locale
  return "applied"
}

export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}
