export type PlaylistStoreItem = {
  playlistItemId: string
  trackId: string
  tags: string[]
  date?: string
  title: string
  author?: string
  location?: string
  completedAt?: number
  references: string[]
  progress?: number
}