import { IRepository } from '@lectorium/dal/index'
import { MediaItem, PlaylistItem } from '@lectorium/dal/models'

export type InitOptions = {
  mediaItemsRepository: IRepository<MediaItem>
  playlistItemsRepository: IRepository<PlaylistItem>
}