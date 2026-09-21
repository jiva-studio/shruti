import type { LanguageCode } from "@lib/domain/core.js"
import {
  defaultLibraryLanguages,
  reduceLocaleToContentLanguage,
} from "@usecases/library/reduceLocaleToLibraryLanguages.js"

export interface LanguageSeed {
  languages: readonly string[]
  /** False when the catalog languages could not be read, so the seed is a guess. */
  fromDb: boolean
}

/**
 * Default library language(s) for a device locale, constrained to languages the
 * catalog has lectures in. Reducing the UI locale (uk → ru) is essential: a
 * strict `language = uiLocale` filter empties the library for any UI language
 * with no audio of its own.
 */
export function pickSeedLanguages(
  locale: string,
  available: readonly LanguageCode[]
): LanguageSeed {
  return available.length > 0
    ? { languages: defaultLibraryLanguages(locale, available), fromDb: true }
    : { languages: [reduceLocaleToContentLanguage(locale)], fromDb: false }
}
