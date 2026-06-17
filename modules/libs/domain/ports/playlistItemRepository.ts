import type { PlaylistItemId, TrackId } from "../core.js"
import type { PlaylistItem } from "../playlistItem.js"

export interface IPlaylistItemRepository {
  getById(id: PlaylistItemId): Promise<PlaylistItem | null>
  listActive(): Promise<readonly PlaylistItem[]>
  listArchived(): Promise<readonly PlaylistItem[]>
  add(trackId: TrackId, collectionId?: string | null): Promise<PlaylistItem>
  archive(id: PlaylistItemId): Promise<void>
  remove(id: PlaylistItemId): Promise<void>
  clearAll(): Promise<void>
}
