import { Ref, watch } from 'vue'
import { createSharedComposable } from '@vueuse/core'
import { useSearchFiltersDictionaryStore } from './useSearchFiltersDictionaryStore'
import { AuthorsService, DurationsService, LanguagesService, LocationsService, SourcesService, SortMethodsService } from '@lectorium/dal/index'

export type Options = {
  authorsService: AuthorsService,
  sourcesService: SourcesService,
  locationsService: LocationsService,
  languagesService: LanguagesService,
  durationsService: DurationsService,
  sortMethodsService: SortMethodsService,
  language: Ref<string>
}

export const useTracksSearchFiltersTask = createSharedComposable(({
  authorsService,
  sourcesService,
  locationsService,
  languagesService,
  durationsService,
  sortMethodsService,
  language
}: Options) => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const searchFiltersDictionaryStore = useSearchFiltersDictionaryStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(language, async () => await onRefresh(), { immediate: true })


  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onRefresh() {
    const [
      authors, sources, locations, languages, durations, sortMethods
    ] = await Promise.all([
      authorsService.getAll(),
      sourcesService.getAll(),
      locationsService.getAll(),
      languagesService.getAll(),
      durationsService.getAll(),
      sortMethodsService.getAll(),
    ])

    searchFiltersDictionaryStore.authors = authors.map((item) => ({
      id: item._id.replace('author::', ''),
      title: item.fullName[language.value] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.sources = sources.map((item) => ({
      id: item._id.replace('source::', ''),
      title: item.fullName[language.value] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.locations = locations.map((item) => ({
      id: item._id.replace('location::', ''),
      title: item.fullName[language.value] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.durations = durations
      .sort((a, b) => a.minDuration - b.minDuration)
      .map((item) => ({
        id: item._id.replace('duration::', ''),
        title: item.fullName[language.value] 
               || item.fullName['en']
               || item.fullName[Object.keys(item.fullName)[0]]
               || item._id,
      }))

    searchFiltersDictionaryStore.sort = sortMethods.map((item) => ({
      id: item._id.replace('sort::', ''),
      title: item.fullName[language.value] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.languages = languages.map((item) => ({
      id: item._id.replace('language::', ''),
      title: item.icon + ' ' + item.fullName,
    })).sort((a, b) => a.title.localeCompare(b.title))
  }
})