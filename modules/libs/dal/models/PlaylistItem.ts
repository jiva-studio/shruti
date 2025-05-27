export type PlaylistItem = {
  /**
   * Unique identifier for the playlist item
   */
  _id: string
  
  /**
   * Static type of the record in the collection in the database
   */
  type: "playlistItem"
  
  /**
   * Track ID
   */
  trackId: string
  
  /**
   * Added date (in milliseconds since epoch)
   */
  addedAt: number

  /**
   * Date when the track was completed (in milliseconds since epoch)
   */
  completedAt: number | undefined

  /**
   * Archived date (in milliseconds since epoch)
   */
  archivedAt: number | undefined
}
