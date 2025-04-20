import { MediaService, BucketService } from '@/app'
import { PlaylistItemsService, TracksService } from '@lectorium/dal/index'
import { S3Operation } from '@lectorium/protocol/index'

/**
 * Scenario for adding a track to a playlist.
 */
export class UserAddsTrackToPlaylistScenario {
  constructor(
    private readonly tracks: TracksService,
    private readonly playlistItems: PlaylistItemsService,
    private readonly media: MediaService,
    private readonly bucketService: BucketService,
    private readonly bucketName: string,
  ) {}

  async execute(
    trackId: string,
  ) {
    // Add track to playlist, or exit if it already exists
    const existingPlayListItem = await this.playlistItems.findOne({ _id: trackId })
    if (existingPlayListItem) { return }

    // Get track information
    const track = await this.tracks.getOne(trackId)

    // Add track to playlist
    await this.playlistItems.addOne({
      _id: trackId,
      trackId: trackId,
      type: 'playlistItem',
      order: 0,
      played: 0,
    })

    const signedUrl = await this.bucketService.getSignedUrl({
      key: track.audio.original.path,
      bucketName: this.bucketName,
      expiresIn: 60 * 60 * 24,
      operation: S3Operation.GetObject,
    })

    // Enqueue related media to download
    // TODO: add support for multiple media items
    // TODO: get track title in the current language
    await this.media.get({
      trackId: trackId,
      url: signedUrl.signedUrl, 
      destination: track.audio.original.path,
      title: track.title?.en ?? 'Unknown', // TODO: use localized title
    })

    // Download all related transcripts

    for (const transcript of Object.values(track.transcripts)) {
      const signedUrl = await this.bucketService.getSignedUrl({
        key: transcript.path,
        bucketName: this.bucketName,
        expiresIn: 60 * 60 * 24,
        operation: S3Operation.GetObject,
      })
      await this.media.get({
        trackId: trackId,
        url: signedUrl.signedUrl, 
        destination: transcript.path,
        title: track.title?.en ?? 'Unknown', // TODO: use localized title
      })
    }
  }

}