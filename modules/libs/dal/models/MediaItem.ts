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
   * The status of the media item.
   * 
   * - `pending`: The media item is pending download.
   * - `downloading`: The media item is currently being downloaded.
   * - `available`: The media item has been downloaded and is available for use.
   * - `failed`: The media item failed to download.
   * - `paused`: The media item download is paused.
   */
  status: 'pending' | 'downloading' | 'available' | 'failed' | 'paused'

  /**
   * The downloader task ID associated with this media item.
   */
  taskId: string
}
