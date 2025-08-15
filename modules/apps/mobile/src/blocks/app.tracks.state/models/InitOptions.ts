import { IRepository } from '@shruti/dal'
import { MediaItem, PlaylistItem } from '@shruti/dal'

export type InitOptions = {
  mediaItemsRepository: IRepository<MediaItem>,
  playlistItemsRepository: IRepository<PlaylistItem>
}
