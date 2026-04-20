import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { AuthorId, LanguageCode, LocationId, SourceId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"

/**
 * Shared cache of content-DB dictionaries (authors / locations / sources /
 * languages). Each dictionary is small (< 1000 rows) and invariant for the
 * session — loading them per-view was duplicating four SQL round trips on
 * every Home ↔ Search navigation.
 *
 * `ensureLoaded()` hydrates on first call; subsequent calls short-circuit.
 * `sorted` views re-derive when the active UI language changes so titles
 * stay in locale order.
 */
export const useDictionariesStore = defineStore("dictionaries", () => {
  const app = useShruti()
  const appLanguage = useAppLanguage()

  const authors = ref<readonly Author[]>([])
  const locations = ref<readonly Location[]>([])
  const sources = ref<readonly Source[]>([])
  const languages = ref<readonly Language[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    if (isLoading.value) return
    isLoading.value = true
    error.value = null
    try {
      const repos = app.repositories()
      const [authorList, languageList, locationList, sourceList] = await Promise.all([
        repos.authors.listAll(),
        repos.languages.listAll(),
        repos.locations.listAll(),
        repos.sources.listAll(),
      ])
      authors.value = authorList
      languages.value = languageList
      locations.value = locationList
      sources.value = sourceList
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load dictionaries"
    } finally {
      isLoading.value = false
    }
  }

  const authorsById = computed<ReadonlyMap<AuthorId, Author>>(() =>
    new Map(authors.value.map((a) => [a.id, a]))
  )
  const locationsById = computed<ReadonlyMap<LocationId, Location>>(() =>
    new Map(locations.value.map((l) => [l.id, l]))
  )
  const sourcesById = computed<ReadonlyMap<SourceId, Source>>(() =>
    new Map(sources.value.map((s) => [s.id, s]))
  )
  const languagesByCode = computed<ReadonlyMap<LanguageCode, Language>>(() =>
    new Map(languages.value.map((l) => [l.code, l]))
  )

  const authorsSorted = computed<readonly Author[]>(() => {
    const lang = appLanguage.value
    return [...authors.value].sort((a, b) =>
      (a.names.get(lang) ?? a.id).localeCompare(b.names.get(lang) ?? b.id)
    )
  })

  const locationsSorted = computed<readonly Location[]>(() => {
    const lang = appLanguage.value
    return [...locations.value].sort((a, b) =>
      (a.names.get(lang) ?? a.id).localeCompare(b.names.get(lang) ?? b.id)
    )
  })

  return {
    authors,
    locations,
    sources,
    languages,
    authorsById,
    locationsById,
    sourcesById,
    languagesByCode,
    authorsSorted,
    locationsSorted,
    isLoading,
    error,
    ensureLoaded,
  }
})
