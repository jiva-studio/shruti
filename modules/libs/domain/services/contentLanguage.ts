import type { LanguageCode } from "../core.js"

/**
 * Locale → content-language reduction policy.
 *
 * The app UI ships in many languages, but lectures (and the chat backend's
 * proactive prompts) exist in only a few content languages (today: ru, en). A
 * user whose UI locale has no content of its own (uk, sr, hi, …) must still get
 * a sensible default, so we *reduce* the UI locale to one content language we
 * actually have.
 *
 * This is intentionally the ONE place that policy lives — it is expected to
 * change over time (new content languages, finer regional rules). Keep the rule
 * here; everything else (library defaults, the proactive chat wire locale, …)
 * reads the result rather than re-deriving it.
 *
 * Current rule: East-Slavic UI (Russian, Ukrainian) → Russian; everyone else →
 * English.
 */
const RUSSIAN_REDUCED_LOCALES = new Set(["ru", "uk"])

/** The base content language a UI locale reduces to, ignoring availability. */
export function reduceLocaleToContentLanguage(uiLocale: string): LanguageCode {
  const base = (uiLocale || "").toLowerCase().split(/[-_]/)[0]
  return RUSSIAN_REDUCED_LOCALES.has(base) ? "ru" : "en"
}
