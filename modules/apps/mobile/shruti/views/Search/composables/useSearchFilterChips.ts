import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"
import type { SearchFilterChipDef } from "@ui/features/tracks/search/filters/index.js"
import IconAuthors from "@ui/features/tracks/search/filters/icons/IconAuthors.vue"
import IconLanguages from "@ui/features/tracks/search/filters/icons/IconLanguages.vue"
import IconLocations from "@ui/features/tracks/search/filters/icons/IconLocations.vue"
import IconClock from "@ui/features/tracks/search/filters/icons/IconClock.vue"
import IconSort from "@ui/features/tracks/search/filters/icons/IconSort.vue"

export interface UseSearchFilterChipsReturn {
  /** Chip definitions for `<SearchFiltersBar :chips>`. Reactive to UI
   *  language changes so localised author/location names refresh
   *  without a re-query. */
  chips: ComputedRef<readonly SearchFilterChipDef[]>
}

/**
 * Builds the search-filter chip configuration (icons + items + titles)
 * from the loaded dictionaries. All wiring lives in one place so
 * `SearchFiltersBar` can stay agnostic of the specific filter set.
 */
export function useSearchFilterChips(): UseSearchFilterChipsReturn {
  const appLanguage = useAppLanguage()
  const dictionaries = useDictionariesStore()
  const { t } = useI18n()

  const authorsItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.authorsSorted.map((a) => ({
      id: a.id,
      title: a.names.get(appLanguage.value) ?? a.id,
    }))
  )

  const languagesItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.languages.map((l) => ({ id: l.code, title: l.fullName }))
  )

  const locationsItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.locationsSorted.map((l) => ({
      id: l.id,
      title: l.names.get(appLanguage.value) ?? l.id,
    }))
  )

  const durationItems = computed<SelectorDialogItem[]>(() => [
    { id: "short", title: t("search.filters.durationShort") },
    { id: "medium", title: t("search.filters.durationMedium") },
    { id: "long", title: t("search.filters.durationLong") },
  ])

  const sortItems = computed<SelectorDialogItem[]>(() => [
    { id: "byDate", title: t("search.filters.dates") },
    { id: "byReference", title: t("search.filters.sort") },
  ])

  const chips = computed<readonly SearchFilterChipDef[]>(() => [
    {
      kind: "multi",
      key: "languages",
      model: "languages",
      title: t("search.filters.languages"),
      icon: IconLanguages,
      items: languagesItems.value,
    },
    {
      kind: "multi",
      key: "authors",
      model: "authors",
      title: t("search.filters.authors"),
      icon: IconAuthors,
      items: authorsItems.value,
    },
    {
      kind: "multi",
      key: "locations",
      model: "locations",
      title: t("search.filters.locations"),
      icon: IconLocations,
      items: locationsItems.value,
    },
    {
      kind: "single",
      key: "duration",
      model: "duration",
      title: t("search.filters.duration"),
      icon: IconClock,
      items: durationItems.value,
    },
    {
      kind: "single",
      key: "sort",
      model: "sort",
      title: t("search.filters.sort"),
      icon: IconSort,
      items: sortItems.value,
    },
  ])

  return { chips }
}
