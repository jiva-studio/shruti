import { IRepository } from '@shruti/dal/index'
import { PlaylistItem, Track } from '@shruti/dal/models'

export type InitOptions = {
  playlistItemsRepository: IRepository<PlaylistItem>
  tracksRepository: IRepository<Track>
  idGenerator: () => string
}