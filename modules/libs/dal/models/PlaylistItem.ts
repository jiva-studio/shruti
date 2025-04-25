export type PlaylistItem = {
  _id: string
  type: "playlistItem"
  trackId: string
  order: number
  played: number

  completedAt: number | undefined
}
