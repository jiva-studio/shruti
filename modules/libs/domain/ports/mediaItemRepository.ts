import type { MediaItemId, TrackId } from "../core.js"
import type { MediaItem, MediaItemState } from "../mediaItem.js"

export interface IMediaItemRepository {
  getByTrack(trackId: TrackId): Promise<MediaItem | null>
  listReady(): Promise<readonly MediaItem[]>
  upsert(trackId: TrackId, state: MediaItemState, localPath: string | null): Promise<MediaItem>
  deleteByTrack(trackId: TrackId): Promise<void>
  deleteById(id: MediaItemId): Promise<void>
}
