import { IRepository } from '@lectorium/dal'
import { PlaylistItem, Track } from '@lectorium/dal'

export type InitOptions = {
  playlistItemsRepository: IRepository<PlaylistItem>
  tracksRepository: IRepository<Track>
  idGenerator: () => string
}