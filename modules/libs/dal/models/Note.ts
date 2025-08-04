export type Note = {
  _id: string
  type: 'note'

  /**
   * Track ID this note belongs to.
   */
  trackId: string
  
  /**
   * Text of the note.
   */
  text: string
  
  /**
   * Start and end time of the note.
   */
  timeStart: number

  /**
   * End time of the note.
   */
  timeEnd: number
  
  /**
   * Timestamp when the note was created.
   */
  createdAt: number
}
