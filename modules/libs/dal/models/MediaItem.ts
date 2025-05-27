export type MediaItem = {
  _id: string
  type: 'mediaItem'

  /**
   * Remote URL of a media item to be downloaded.
   */
  remoteUrl: string

  /**
   * Local path where the media item to be saved. 
   */
  localPath: string
  
  /**
   * The media item ID associated with this media item.
   */
  trackId: string

  /**
   * The status of the media item.
   */
  state: 'pending' | 'ready' | 'failed'
}
