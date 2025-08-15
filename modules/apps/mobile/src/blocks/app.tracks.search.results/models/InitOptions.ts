import { IndexService, IRepository, TracksSearchService } from '@lectorium/dal'
import { Duration, Source } from '@lectorium/dal'

export type InitOptions = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}