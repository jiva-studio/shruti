export enum PlaylistItemStatus {
  New,
  Playing,
  Played,
}

export type Aviability = "available" | "unavailable" | "downloaded" | "unknown"

export type PlaylistItem = {
  trackId: string
  collectionId?: string
  order: number
  played: number

  mediaStatus: Aviability
  transcriptStatus: Aviability
}
