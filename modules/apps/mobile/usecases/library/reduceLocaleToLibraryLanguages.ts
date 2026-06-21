import type { LanguageCode } from "@lib/domain/core.js"
// The pure locale→content-language policy lives in the domain layer so infra
// (e.g. the proactive chat wire locale) can share it without crossing the
// app-layer boundary. Re-exported here for existing callers.
import { reduceLocaleToContentLanguage } from "@lib/domain/services/contentLanguage.js"

export { reduceLocaleToContentLanguage }

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
