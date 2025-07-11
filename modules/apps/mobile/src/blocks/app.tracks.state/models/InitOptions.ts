import { IRepository } from '@shruti/dal/index'
import { MediaItem, PlaylistItem } from '@shruti/dal/models'

export type InitOptions = {
  mediaItemsRepository: IRepository<MediaItem>,
  playlistItemsRepository: IRepository<PlaylistItem>
}
