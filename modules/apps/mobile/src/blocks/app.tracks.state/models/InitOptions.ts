import { IRepository } from '@lectorium/dal'
import { MediaItem, PlaylistItem } from '@lectorium/dal'

export type InitOptions = {
  mediaItemsRepository: IRepository<MediaItem>,
  playlistItemsRepository: IRepository<PlaylistItem>
}
