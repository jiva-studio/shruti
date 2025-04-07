export type MediaItem = {
  _id: string

  // Title of the media item
  title: string

  // Remote url to download file
  remoteUrl: string

  // Path to file on device
  localUrl?: string

  // Downloading state
  state: 'downloaded' | 'downloading' | 'pending' | 'failed'

  // Size in bytes
  size?: number

  // Any meta information
  meta?: any
}
