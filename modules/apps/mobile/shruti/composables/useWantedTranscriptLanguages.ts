import { computed, type ComputedRef } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { reduceLocaleToContentLanguage } from "@lib/domain/services/contentLanguage.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"

export interface WantedTranscriptLanguages {
  /**
   * The languages a transcript is worth keeping on disk in: the user's
   * library (lecture) languages plus the interface language, which the
   * Transcript dialog can switch to. Ordered library-first; deduplicated.
   */
  languages: ComputedRef<readonly LanguageCode[]>
  /**
   * False until the persisted library-language selection has been read back.
   * Before that the set is a guess built from the UI locale alone, so callers
   * must treat it as "unknown" rather than as a restriction.
   */
  ready: ComputedRef<boolean>
}

/**
 * Which transcript languages this user actually reads.
 *
 * Two sources: the **library languages** (Settings → Lecture languages, the
 * same facet that decides which lectures are shown at all) and the **app
 * language** — the transcript dialog offers it as a chip, and on a personal
 * -library track it can be translated into on the spot. The UI locale is also
 * reduced to a content language (uk → ru, everything else → en) so a locale we
 * publish no lectures in still contributes the language its speaker reads.
 */
export function useWantedTranscriptLanguages(): WantedTranscriptLanguages {
  const libraryLanguages = useLibraryLanguages()
  const appLanguage = useAppLanguage()
  const filters = useSearchFiltersStore()

  const languages = computed<readonly LanguageCode[]>(() => {
    const locale = appLanguage.value ?? ""
    const wanted = new Set<LanguageCode>(libraryLanguages.value)
    const base = locale.toLowerCase().split(/[-_]/)[0]
    if (base) wanted.add(base)
    if (locale) wanted.add(reduceLocaleToContentLanguage(locale))
    return [...wanted]
  })

  return { languages, ready: computed(() => filters.loaded) }
}
