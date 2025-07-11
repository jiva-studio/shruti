export type TranscriptLanguage = {
  code: string
  name: string
  icon: string
}

export type TranscriptParagraph = {
  sentences: TranscriptSentence[]
}

export type TranscriptSentence = {
  id: string
  sequentalId: number,
  type: 'sentence' | 'paragraph'
  text: string
  start: number
  end: number
  speaker: string
  language: string
  highlighted: boolean
  selected: boolean
  icon: string
}