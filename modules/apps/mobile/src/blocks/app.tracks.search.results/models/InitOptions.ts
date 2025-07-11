import { IndexService, IRepository, TracksSearchService } from '@shruti/dal/index'
import { Duration, Source } from '@shruti/dal/models'

export type InitOptions = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}