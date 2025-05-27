import { Source, Duration } from '@lectorium/dal/models'
import { DurationsService, IndexService, SourcesService, TracksService } from '@lectorium/dal/index'
import { TrackSearchFilters } from '../models/TrackSearchFilters'
import { useTrackToSearchResultMapper } from './useTrackToSearchResultMapper'

type Options = {
  indexService: IndexService
  tracksService: TracksService
  sourcesService: SourcesService
  durationsService: DurationsService
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
  sourcesService,
  durationsService,
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
      duration = await durationsService.findOne({ _id: 'duration::' + filters.duration })
    }

    // TODO: cache sources names
    const sources = await sourcesService.getAll()
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
    const result = await tracksService.find({
      ids: searchQueryTrackIds.ids, 
      authors: filters.authors,
      sources: filters.sources,
      locations: filters.locations,
      languages: filters.languages,
      dates: filters.dates,
      duration: duration 
        ? { min: duration.minDuration, max: duration.maxDuration } 
        : { min: 0, max: Number.MAX_SAFE_INTEGER },
      skip: offset,
      limit: limit,
    })

    return await Promise.all(
      result.map(async track => await trackToSearchResultMapper.map({ track, language }))
    )
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load }
}