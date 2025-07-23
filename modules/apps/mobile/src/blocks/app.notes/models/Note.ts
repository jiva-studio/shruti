export type Note = {
  id: string
  trackId: string,
  text: string,
  language: string,
  blocks: string[],
  trackAuthor: string,
  trackTitle: string,
  tags?: string[],
  color?: string,
}
