import { MediaItemsService, PlaylistItemsService, TracksService } from '@lectorium/dal/index'
import { mapTrackToPlaylistItem } from '../mappers/tracks'
import { Track } from '@lectorium/dal/models'

type TrackStatus = 'none' | 'loading' | 'failed'
const LoadingStatuses = ['pending', 'running', 'paused']
const FailedStatuses = ['failed']


export class TracksListScenario {
  protected async map(
    track: Track,
    enricher: (track: Track) => object
  ) {
    const mapedItem = await mapTrackToPlaylistItem(track)
    return { ...mapedItem, ...enricher(track) }
  }
}


export class UserSeesUpNextTracksScenario extends TracksListScenario{
  constructor(
    private readonly playlistItems: PlaylistItemsService,
    private readonly mediaItems: MediaItemsService,
    private readonly tracks: TracksService,
  ) { 
    super()
  }

  async execute() {
    // Get next 10 tracks from the playlist
    const playlistItems = await this.playlistItems.getAll({ limit: 10 })
    const upNextTrackIds = playlistItems.map(item => item.trackId)
    const upNextTracks = await this.tracks.getMany({
      selector: { _id : { $in: upNextTrackIds } },
    })

    // Get related media items
    const mediaItems = await this.mediaItems.getMany({
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
        const isLoading = trackMediaItems.some(item => LoadingStatuses.includes(item.taskStatus))
        const isFailed = trackMediaItems.some(item => FailedStatuses.includes(item.taskStatus))
        acc[trackId] = trackMediaItems.length === 0 || isFailed ? 'failed' : isLoading ? 'loading' : 'none'
        return acc
      }, {})

    // Enrich tracks with their statuses
    const trackStatusEnricher = (track: Track) => ({ status: trackStatuses[track._id] })
    const trackMappers = upNextTracks.map((x) => this.map(x, trackStatusEnricher))
    return await Promise.all(trackMappers)
  }
}