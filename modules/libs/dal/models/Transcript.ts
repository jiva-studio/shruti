
export type WithTiming = {
  start: number
  end: number
}

/* -------------------------------------------------------------------------- */
/*                           Transcript Block Types                           */
/* -------------------------------------------------------------------------- */

/**
 * Paragraph delimiter to separate blocks of text.
 * This is used to indicate a new paragraph in the transcript.
 * It does not contain any text or speaker information.
 */
export type TranscriptParagraphBlock = {
  type: "paragraph"
} & WithTiming

/**
 * Sentence block containing text, speaker information, and reference.
 * This block represents a single sentence in the transcript.
 * It includes the text of the sentence, the speaker's name, and an optional reference.
 */
export type TranscriptSentenceBlock = {
  type: "sentence"
  text: string
  speaker?: string
  reference?: (string | number)[]
} & WithTiming

/**
 * Verse text block containing text and an optional reference.
 */
export type TranscriptVerseTextBlock = {
  type: "verse:text";
  text: string[];
  reference?: (string|number)[];
} & WithTiming

/**
 * Verse translation block containing translated text.
 */
export type TranscriptVerseTranslationBlock = {
  type: "verse:translation";
  text: string;
} & WithTiming

export type TranscriptBlock = 
  | TranscriptParagraphBlock 
  | TranscriptSentenceBlock 
  | TranscriptVerseTextBlock 
  | TranscriptVerseTranslationBlock


/* -------------------------------------------------------------------------- */
/*                                 Transcript                                 */
/* -------------------------------------------------------------------------- */


/**
 * Transcript type representing a collection of blocks.
 */
export type Transcript = {
  version: number;
  blocks: TranscriptBlock[];
}

