export type Date = [number, number, number]
export type Title = Record<string, string>
type Location = { id?: string, name?: string }

export type TrackProps = {
  _id: string
  title: Title
  url: string
  location?: Location
  date: Date,
  references: Array<string[]>
  languages: TrackLanguage[]
  author: string
  sourceUrl?: string
}

export type TrackLanguage = {
  language: string
  source: 'track' | 'transcript'
  type: 'original' | 'generated' | 'redacted'
}

export type TrackTranscriptBlock = {
  type: string
  start: number
  end: number
  text: string
}

export type TrackTranscriptText = {
  blocks: TrackTranscriptBlock[]
}

export type TrackTranscript = {
  text: TrackTranscriptText
}

export class Track {
  constructor(
    public props: TrackProps
  ) {}

  /**
   * Getter for the `_id` property.
   *
   * @returns The unique identifier of the source.
   */
  get _id(): string { return this.props._id }
  getTitle(language: string): string { return this.props.title[language] || this.props.title[Object.keys(this.props.title)[0]] || 'No title' }
  get url(): string { return this.props.url }
  get location(): Location | undefined { return this.props.location }
  get date(): Date { return this.props.date }
  get references(): Array<string[]> { return this.props.references }
  get languages(): TrackLanguage[] { return this.props.languages }
  get author(): string { return this.props.author }
}
