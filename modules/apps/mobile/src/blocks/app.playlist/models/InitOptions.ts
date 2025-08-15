import { IRepository } from '@shruti/dal'
import { PlaylistItem, Track } from '@shruti/dal'

export type InitOptions = {
  playlistItemsRepository: IRepository<PlaylistItem>
  tracksRepository: IRepository<Track>
  idGenerator: () => string
}