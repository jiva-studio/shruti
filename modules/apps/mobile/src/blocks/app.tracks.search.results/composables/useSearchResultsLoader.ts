import { Source, Duration } from '@lectorium/dal'
import { IRepository, IndexService, TracksSearchService } from '@lectorium/dal'
import { TrackSearchFilters } from '../models/TrackSearchFilters'
import { useTrackToSearchResultMapper } from './useTrackToSearchResultMapper'

type Options = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}

type SearchRequest = {
  filters: TrackSearchFilters
  language?: string
  offset?: number
  limit?: number
}

export function useSearchResultsLoader({
  indexService,
  tracksService,
  sourcesRepository,
  durationsRepository,
}: Options) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const trackToSearchResultMapper = useTrackToSearchResultMapper()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load({
    filters, 
    offset = 0,
    limit = 25,
    language = 'en',
  }: SearchRequest) {
    let duration: Duration | undefined = undefined
    if (filters.duration) {
      duration = await durationsRepository.findOne({ _id: 'duration::' + filters.duration })
    }

    const sources = await sourcesRepository.getAll()
    const sourcesNames = sources.reduce(
        (map: Record<string, string>, { _id, shortName }: Source
      ) => {
        Object
          .values(shortName)
          .forEach(translation => map[translation] = _id.replace('source::', ''))
        return map
      }, {})

    const tokens = (filters.query || '').split(' ')
    const translatedTokens = tokens.map(token => {
      const translatedToken = Object.keys(sourcesNames).find(key => key.toLowerCase() === token.toLowerCase())
      return translatedToken ? sourcesNames[translatedToken] : token
    })
    const translatedQuery = translatedTokens.join(' ')

    // Search track IDs using index service    
    const searchQueryTrackIds = translatedQuery
      ? await indexService.search(translatedQuery)
      : { ids: undefined }

    // Perform final search using all filters and ids
    // form the previous step
    const searchResult = await tracksService.find({
      ids: searchQueryTrackIds.ids, 
      authors: filters.authors,
      sources: filters.sources,
      locations: filters.locations,
      languages: filters.languages,
      dates: filters.dates,
      duration: duration 
        ? { min: duration.minDuration, max: duration.maxDuration } 
        : { min: 0, max: Number.MAX_SAFE_INTEGER },
      sort: filters.sort,
      skip: offset,
      limit: limit,
    })

    const mappedResult = await Promise.all(
      searchResult.map(async track => await trackToSearchResultMapper.map({ track, language }))
    )
    return mappedResult
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load }
}