import { mapTrackToPlaylistItem } from '../mappers/tracks'
import { Track } from '@lectorium/dal/models'
import { useDAL } from '@/app'

type TrackStatus = 'none' | 'loading' | 'failed' | 'completed'
const LoadingStatuses = ['pending', 'running', 'paused']
const FailedStatuses = ['failed']

export function useUserSeesUpNextTracksScenario() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(
    language: string = 'en'
  ) {
    // Get next 10 tracks from the playlist
    const playlistItems = await dal.playlistItems.getMany({
      limit: 10,
      sort: ['addedAt'],
      selector: { 
        type: 'playlistItem', 
        addedAt: { $gte: null } 
      },
    })
    const upNextTrackIds = playlistItems.map(item => item.trackId)
    const upNextTracks = await dal.tracks.getMany({
      selector: { _id : { $in: upNextTrackIds } },
    })

    // Get related media items
    const mediaItems = await dal.mediaItems.getMany({
      selector: { trackId : { $in: upNextTrackIds } },
      limit: 100
    })

    // Create dictionary { trackId: status } of track statuses based
    // on media items statuses
    // - loading: media items are pending, running or paused
    // - failed: media items are failed
    // - none: media items are successful
    const trackStatuses = upNextTrackIds
      .reduce((acc: Record<string, TrackStatus>, trackId) => {
        const trackMediaItems = mediaItems.filter(item => item.trackId === trackId)
        const playListItem = playlistItems.find(item => item.trackId === trackId)
        const isLoading = trackMediaItems.some(item => LoadingStatuses.includes(item.taskStatus))
        const isFailed = trackMediaItems.some(item => FailedStatuses.includes(item.taskStatus))
        if (playListItem?.completedAt) {
          acc[trackId] = 'completed'
        } else if (trackMediaItems.length === 0 || isLoading) {
          acc[trackId] = 'loading'
        } else if (isFailed) {
          acc[trackId] = 'failed'
        } else {
          acc[trackId] = 'none'
        }
        return acc
      }, {})

    // Enrich tracks with their statuses
    const trackStatusEnricher = (track: Track) => ({ status: trackStatuses[track._id] })
    const trackMappers = upNextTrackIds
      .map(x => upNextTracks.find(t => t._id === x)!)  
      .filter(x => x !== undefined)
      .map(x => map(x, language, trackStatusEnricher))
    return await Promise.all(trackMappers)
  }

  async function map(
    track: Track,
    language: string = 'en',
    enricher: (track: Track) => object
  ) {
    const mappedItem = await mapTrackToPlaylistItem(track, language)
    return { ...mappedItem, ...enricher(track) }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute
  }
}