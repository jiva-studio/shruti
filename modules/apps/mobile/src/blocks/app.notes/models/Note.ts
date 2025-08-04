export type Note = {
  id: string
  trackId: string
  language: string
  text: string
  blocks?: string[]
  timeStart: number
  timeEnd: number
  trackAuthor: string
  trackTitle: string
  tags?: string[]
  color?: string
}
