import { MediaItem } from '@lectorium/dal/models/MediaItem'
import { useTrackStateStore } from './useTrackStateStore'
import { MediaItemsService, PlaylistItemsService } from '@lectorium/dal/index'

export type EventArgs = { trackId: string } 
export type EventHandler = (event: EventArgs) => Promise<void>

export type Options = {
  mediaItemsService: MediaItemsService
  playlistItemsService: PlaylistItemsService
}

export async function initTrackState(options: Options) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  const failedStates: MediaItem['state'][] = ['pending', 'failed']

  // Get all tracks that are in the completed state
  const completedPlaylistItems = await options.playlistItemsService.getMany({
    selector: {
      completedAt: { $exists: true },
    },
    limit: 1000, // TODO: Remove limit when pagination is implemented
  })
  completedPlaylistItems.forEach(item => {
    trackStateStore.setState(item.trackId, { isCompleted: true })
  })

  // Get all media items that are in the pending or in failed state
  // and set the download failed status to true for each track
  const failedMediaItems = await options.mediaItemsService.getInState(failedStates)
  const failedTracks = failedMediaItems
    .map(track => track.trackId)
    .filter(id => id !== undefined)
  failedTracks.forEach(trackId => {
    trackStateStore.setState(trackId, { isFailed: true })
  })

  // Set inPlaylist for each track
  const activePlaylistItems = await options.playlistItemsService.getMany({ 
    selector: { archivedAt: { $exists: false } } 
  })
  activePlaylistItems.forEach(item => {
    trackStateStore.setState(item.trackId, { inPlaylist: true })
  })

  // Check all playlist items and set the download failed status
  // to true for each track that has no media items or has media items
  // in the failed state
  for (const playlistItem of activePlaylistItems) {
    const relatedMediaItems = await options.mediaItemsService.getMany({ 
      selector: { trackId: playlistItem.trackId } 
    })

    const mediaItemsEmpty = relatedMediaItems.length === 0
    const mediaItemsFailed = relatedMediaItems.some(
      x => failedStates.includes(x.state)
    )

    if (mediaItemsEmpty || mediaItemsFailed) {
      trackStateStore.setState(playlistItem.trackId, { isFailed: true })
    }
  }
}