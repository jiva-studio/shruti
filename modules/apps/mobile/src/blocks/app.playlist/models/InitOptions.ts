import { IRepository } from '@lectorium/dal/index'
import { PlaylistItem, Track } from '@lectorium/dal/models'

export type InitOptions = {
  playlistItemsRepository: IRepository<PlaylistItem>
  tracksRepository: IRepository<Track>
  idGenerator: () => string
}