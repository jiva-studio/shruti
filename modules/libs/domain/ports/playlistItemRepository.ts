import type { PlaylistItemId, TrackId } from "../core.js"
import type { PlaylistItem } from "../playlistItem.js"
import type { ITransaction } from "./unitOfWork.js"

export interface IPlaylistItemRepository {
  getById(id: PlaylistItemId): Promise<PlaylistItem | null>
  listActive(): Promise<readonly PlaylistItem[]>
  listArchived(): Promise<readonly PlaylistItem[]>
  /* `tx`: the caller's open transaction handle, keeping the write and its
   * journal entry inside it (see {@link ITransaction}). */
  add(trackId: TrackId, collectionId?: string | null, tx?: ITransaction): Promise<PlaylistItem>
  archive(id: PlaylistItemId, tx?: ITransaction): Promise<void>
  remove(id: PlaylistItemId, tx?: ITransaction): Promise<void>
  clearAll(): Promise<void>
}
