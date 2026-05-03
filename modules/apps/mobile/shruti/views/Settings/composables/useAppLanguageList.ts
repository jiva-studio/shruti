import { onMounted, ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@shruti/services/useToast.js"
import type { Language } from "@lib/domain/language.js"
import type { ILanguageRepository } from "@lib/domain/ports/languageRepository.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface UseAppLanguageListReturn {
  items: Ref<SelectorItem[]>
}

const FALLBACK_ITEMS: SelectorItem[] = [
  { id: "en", title: "English" },
  { id: "ru", title: "Русский" },
]

/**
 * Loads the UI-language picker source from the languages repository on
 * mount. On failure (e.g. database not yet migrated) falls back to a
 * minimal hard-coded list and surfaces a toast so users in other
 * locales know the list couldn't load.
 */
export function useAppLanguageList(languagesRepo: ILanguageRepository): UseAppLanguageListReturn {
  const items = ref<SelectorItem[]>([])
  const { t } = useI18n()
  const toast = useToast()

  onMounted(async () => {
    try {
      const langs: readonly Language[] = await languagesRepo.listAll()
      items.value = langs.map((l) => ({ id: l.code, title: l.fullName }))
    } catch (err) {
      console.error("[settings] languages.listAll failed:", err)
      items.value = FALLBACK_ITEMS
      void toast.error(t("errors.languageListUnavailable"))
    }
  })

  return { items }
}
