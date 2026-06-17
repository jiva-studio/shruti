import { onMounted, ref, type Ref } from "vue"
import type { Language } from "@lib/domain/language.js"
import type { ILanguageRepository } from "@lib/domain/ports/languageRepository.js"
import type { SelectorItem } from "./useAppLanguageList.js"

export interface UseContentLanguageListReturn {
  items: Ref<SelectorItem[]>
}

/**
 * Loads the **content** languages — the ones lectures actually exist in — for
 * the Library language picker. Distinct from `useAppLanguageList`, which lists
 * every UI language: here we only offer languages a user can actually filter
 * the library to, and the list grows automatically when a new content language
 * is published. Empty on failure (the picker simply shows nothing rather than
 * offering languages with no lectures).
 */
export function useContentLanguageList(
  languagesRepo: Pick<ILanguageRepository, "listWithTracks">
): UseContentLanguageListReturn {
  const items = ref<SelectorItem[]>([])

  onMounted(async () => {
    try {
      const langs: readonly Language[] = await languagesRepo.listWithTracks()
      items.value = langs.map((l) => ({ id: l.code, title: l.fullName }))
    } catch (err) {
      console.error("[settings] languages.listWithTracks failed:", err)
      items.value = []
    }
  })

  return { items }
}
