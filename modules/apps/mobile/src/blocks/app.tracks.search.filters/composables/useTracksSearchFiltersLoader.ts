import { createSharedComposable } from '@vueuse/core'
import { useSearchFiltersDictionaryStore } from './useSearchFiltersDictionaryStore'
import { IRepository } from '@shruti/dal/index'
import { Author, Source, Location, Language, Duration, SortMethod } from '@shruti/dal/models'

export type Options = {
  authorsService: IRepository<Author>
  sourcesService: IRepository<Source>
  locationsService: IRepository<Location>
  languagesService: IRepository<Language>
  durationsService: IRepository<Duration>
  sortMethodsService: IRepository<SortMethod>
}

export const useTracksSearchFilters = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const searchFiltersDictionaryStore = useSearchFiltersDictionaryStore()


  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function load(language: string) {
    if (!options) { throw new Error('useTracksSearchFiltersLoader is not initialized. Call init(options) first.') }
    const [
      authors, sources, locations, languages, durations, sortMethods
    ] = await Promise.all([
      options.authorsService.getAll({ limit: 1000 }),
      options.sourcesService.getAll({ limit: 1000 }),
      options.locationsService.getAll({ limit: 1000 }),
      options.languagesService.getAll({ limit: 1000 }),
      options.durationsService.getAll({ limit: 1000 }),
      options.sortMethodsService.getAll({ limit: 1000 }),
    ])

    searchFiltersDictionaryStore.authors = authors.map((item) => ({
      id: item._id.replace('author::', ''),
      title: item.fullName[language] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.sources = sources.map((item) => ({
      id: item._id.replace('source::', ''),
      title: item.fullName[language] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.locations = locations.map((item) => ({
      id: item._id.replace('location::', ''),
      title: item.fullName[language] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.durations = durations
      .sort((a, b) => a.minDuration - b.minDuration)
      .map((item) => ({
        id: item._id.replace('duration::', ''),
        title: item.fullName[language] 
               || item.fullName['en']
               || item.fullName[Object.keys(item.fullName)[0]]
               || item._id,
      }))

    searchFiltersDictionaryStore.sort = sortMethods.map((item) => ({
      id: item._id.replace('sort::', ''),
      title: item.fullName[language] 
             || item.fullName['en']
             || item.fullName[Object.keys(item.fullName)[0]]
             || item._id,
    })).sort((a, b) => a.title.localeCompare(b.title))

    searchFiltersDictionaryStore.languages = languages.map((item) => ({
      id: item._id.replace('language::', ''),
      title: item.icon + ' ' + item.fullName,
    })).sort((a, b) => a.title.localeCompare(b.title))
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load, init } 
})