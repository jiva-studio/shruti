import type { Result } from "@kit/core"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import {
  addTrackToPlaylist,
  type AddTrackToPlaylistError,
  type AddTrackToPlaylistInput,
} from "@usecases/playlist/addTrackToPlaylist.js"
import {
  archivePlaylistItem,
  type ArchivePlaylistItemError,
} from "@usecases/playlist/archivePlaylistItem.js"
import {
  listActivePlaylistItems,
  listActivePlaylistTracks,
  type ActivePlaylistPage,
} from "@usecases/playlist/listPlaylistTracks.js"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"
import {
  loadEverCompletedTrackIds,
  loadPlaylistProgress,
  type PlaylistProgress,
} from "@usecases/playlist/playlistHistory.js"
import { resolveTrackForItem } from "@usecases/playlist/resolveTrackForItem.js"
import { useShruti } from "@shruti/shruti.js"

export interface PlaylistUseCases {
  listActiveTracks(): Promise<ActivePlaylistPage>
  listActiveItems(): Promise<readonly PlaylistItem[]>
  loadProgress(entries: readonly PlaylistEntry[]): Promise<PlaylistProgress>
  loadEverCompletedTrackIds(activeItems: readonly PlaylistItem[]): Promise<ReadonlySet<string>>
  resolveTrackForItem(itemId: PlaylistItemId): Promise<Track | undefined>
  add(input: AddTrackToPlaylistInput): Promise<Result<PlaylistItem, AddTrackToPlaylistError>>
  archive(itemId: PlaylistItemId): Promise<Result<void, ArchivePlaylistItemError>>
}

/** The playlist use cases, bound to the repositories, which are resolved per
 *  call and so throw until the databases are open. */
export function usePlaylistUseCases(): PlaylistUseCases {
  const app = useShruti()
  const repos = () => app.repositories()
  return {
    listActiveTracks: () => listActivePlaylistTracks(repos()),
    listActiveItems: () => listActivePlaylistItems(repos()),
    loadProgress: (entries) => loadPlaylistProgress(entries, repos()),
    loadEverCompletedTrackIds: (activeItems) => loadEverCompletedTrackIds(activeItems, repos()),
    resolveTrackForItem: (itemId) => resolveTrackForItem(itemId, repos()),
    add: (input) => addTrackToPlaylist(input, repos()),
    archive: (itemId) => archivePlaylistItem({ itemId }, repos()),
  }
}
