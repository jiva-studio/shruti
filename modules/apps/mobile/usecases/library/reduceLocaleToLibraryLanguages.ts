import type { LanguageCode } from "@lib/domain/core.js"

/**
 * Locale → library-content-language reduction policy.
 *
 * The app UI ships in many languages, but lectures exist in only a few content
 * languages (today: ru, en). A user whose UI locale has no lectures of its own
 * (uk, sr, hi, …) must still get a sensible default library, so we *reduce* the
 * UI locale to one content language we actually have.
 *
 * This is intentionally the ONE place that policy lives — it is expected to
 * change over time (new content languages, finer regional rules). Keep the rule
 * here; everything else reads the result.
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

/**
 * Default library content languages for a fresh install: the UI locale reduced
 * to a content language, constrained to what the catalog actually offers. Uses
 * the reduced language when available, else falls back to en, else the first
 * available. Returns [] only when no content exists at all. Always at most the
 * seed; the user can broaden it later (e.g. enable both ru and en).
 */
export function defaultLibraryLanguages(
  uiLocale: string,
  available: readonly LanguageCode[]
): LanguageCode[] {
  if (available.length === 0) return []
  const reduced = reduceLocaleToContentLanguage(uiLocale)
  if (available.includes(reduced)) return [reduced]
  if (available.includes("en")) return ["en"]
  return [available[0]]
}
