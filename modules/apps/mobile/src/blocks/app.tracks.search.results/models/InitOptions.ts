import { IndexService, IRepository, TracksSearchService } from '@lectorium/dal/index'
import { Duration, Source } from '@lectorium/dal/models'

export type InitOptions = {
  indexService: IndexService
  tracksService: TracksSearchService
  sourcesRepository: IRepository<Source>
  durationsRepository: IRepository<Duration>
}