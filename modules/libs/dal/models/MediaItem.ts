export type MediaItem = {
  _id: string
  type: 'mediaItem'

  /**
   * Title of the media item.
   */
  title: string

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
   * The downloader task ID associated with this media item.
   */
  taskId: string

  /**
   * The status of the media item.
   * 
   * - `pending`: The media item is queued for download.
   * - `running`: The media item is currently being downloaded.
   * - `successful`: The media item has been successfully downloaded.
   * - `failed`: The media item failed to download.
   * - `paused`: The media item download is paused.
   */
  taskStatus: 'pending' | 'running' | 'successful' | 'failed' | 'paused'
}
