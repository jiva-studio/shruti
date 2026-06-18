import { computed, type ComputedRef } from "vue"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { preferredLibraryLanguage } from "@lib/domain/services/localizedName.js"
import type { LanguageCode } from "@lib/domain/core.js"

/**
 * The single content language to load language-scoped library entities —
 * collections and collection groups — in. Each such entity is curated per
 * language (own name, cover and track list), so the UI shows exactly one: the
 * interface language when it is among the selected library languages, else the
 * first selected library language (and the interface language as a last resort
 * when none is selected).
 *
 * This is the collections analogue of {@link useLibraryLanguages}: collections
 * must follow the chosen library content language, NOT the interface locale.
 * Loading a collection in the UI language while the library is set to another
 * language is the bug this fixes — the collection's track ids come back in the
 * wrong language and are then dropped by the library-language track filter,
 * leaving the collection empty. See `preferredLibraryLanguage`.
 */
export function useCollectionLanguage(): ComputedRef<LanguageCode> {
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  return computed(() => preferredLibraryLanguage(libraryLanguages.value, appLanguage.value))
}
