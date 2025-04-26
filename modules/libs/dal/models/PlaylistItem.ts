export type PlaylistItem = {
  _id: string
  type: "playlistItem"
  trackId: string
  played: number

  addedAt: number
  completedAt: number | undefined
}
