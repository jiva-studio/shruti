import { IndexService, IRepository, TracksSearchService } from '@shruti/dal'
import { Duration, Source } from '@shruti/dal'

export type InitOptions = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}