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
   */
  taskStatus: 'running' | 'successful' | 'failed'
}
