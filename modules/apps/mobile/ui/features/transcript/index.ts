export { default as TranscriptDialog } from "./TranscriptDialog.vue"

export { default as TranscriptSelectionPopover } from "./TranscriptSelectionPopover.vue"

export type {
  UiTranscriptBlockRaw,
  UiTranscriptBlockView,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
  UiTranscriptSentenceBlock,
  UiTranscriptVerseTextBlock,
  UiTranscriptVerseTranslationBlock,
} from "./types.js"

export type { UiTimeRange } from "./timeRange.js"
export type { TextSelectedEvent, NoteTappedEvent } from "./TranscriptText.vue"
export type { SelectionAction, ExistingNoteSelection } from "./TranscriptSelectionPopover.vue"
