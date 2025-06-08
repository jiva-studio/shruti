export type Note = {
  id: string
  trackId: string,
  text: string,
  blocks: string[],
  trackAuthor: string,
  trackTitle: string,
  tags?: string[],
  color?: string,
}
