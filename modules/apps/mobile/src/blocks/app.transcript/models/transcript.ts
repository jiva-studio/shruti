// import { TranscriptBlock } from '@lectorium/dal'

/**
 * Language for the transcript.
 * It contains the language code, name, and icon.
 */
export type TranscriptLanguage = {
  code: string
  name: string
  icon: string
}

/* -------------------------------------------------------------------------- */
/*                           Transcript Block Views                           */
/* -------------------------------------------------------------------------- */

export type WithTiming = {
  start: number
  end: number
}

export type TranscriptParagraphBlockView = {
  type: 'paragraph'
} & WithTiming

export type TranscriptSentenceBlockView = {
  type: 'sentence'
  text: string
  speaker?: string
  reference?: string
  speakerChanged?: boolean
} & WithTiming

export type TranscriptVerseTextBlockView = {
  type: 'verse:text';
  text: string[];
  reference?: string;
} & WithTiming

export type TranscriptVerseTranslationBlockView = {
  type: 'verse:translation';
  text: string;
} & WithTiming

/**
 * Transcript block view with additional properties for UI representation.
 */
export type TranscriptBlockView = {
  /**
   * Transcript block itself.
   */
  block: 
    | TranscriptParagraphBlockView
    | TranscriptSentenceBlockView
    | TranscriptVerseTextBlockView 
    | TranscriptVerseTranslationBlockView
  
  /**
   * Language of the block.
   */
  language: string

  /**
   * Is this block bookmarked by the user?
   */
  bookmarked: boolean

  /**
   * Is this block selected by the user?
   */
  selected: boolean

  /**
   * Icon
   */
  icon?: string
}



export type TranscriptBlocksGroupView = {
  blocks: TranscriptBlockView[]
}