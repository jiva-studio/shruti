import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { AuthorId, LanguageCode, LocationId, SourceId, TagId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"

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
  const app = useLectorium()
  const appLanguage = useAppLanguage()

  const authors = ref<readonly Author[]>([])
  const locations = ref<readonly Location[]>([])
  const sources = ref<readonly Source[]>([])
  const tags = ref<readonly Tag[]>([])
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
      const [authorList, languageList, locationList, sourceList, tagList] = await Promise.all([
        repos.authors.listAll(),
        repos.languages.listAll(),
        repos.locations.listAll(),
        repos.sources.listAll(),
        repos.tags.listAll(),
      ])
      authors.value = authorList
      languages.value = languageList
      locations.value = locationList
      sources.value = sourceList
      tags.value = tagList
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load dictionaries"
    } finally {
      isLoading.value = false
    }
  }

  const authorsById = computed<ReadonlyMap<AuthorId, Author>>(
    () => new Map(authors.value.map((a) => [a.id, a]))
  )
  const locationsById = computed<ReadonlyMap<LocationId, Location>>(
    () => new Map(locations.value.map((l) => [l.id, l]))
  )
  const sourcesById = computed<ReadonlyMap<SourceId, Source>>(
    () => new Map(sources.value.map((s) => [s.id, s]))
  )
  const tagsById = computed<ReadonlyMap<TagId, Tag>>(
    () => new Map(tags.value.map((t) => [t.id, t]))
  )
  /** Tag-id → localised display name in the active UI language. Used by the
   *  list-row builder as the chip fallback when a track has no scripture
   *  reference. Falls back to the first available locale, then the bare id. */
  const tagNamesById = computed<ReadonlyMap<string, string>>(() => {
    const lang = appLanguage.value
    const out = new Map<string, string>()
    for (const t of tags.value) {
      const name = t.names.get(lang) ?? t.names.values().next().value ?? t.id
      out.set(t.id, name)
    }
    return out
  })
  const languagesByCode = computed<ReadonlyMap<LanguageCode, Language>>(
    () => new Map(languages.value.map((l) => [l.code, l]))
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
    tags,
    languages,
    authorsById,
    locationsById,
    sourcesById,
    tagsById,
    tagNamesById,
    languagesByCode,
    authorsSorted,
    locationsSorted,
    isLoading,
    error,
    ensureLoaded,
  }
})
