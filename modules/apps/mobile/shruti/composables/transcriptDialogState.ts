import type { ComputedRef, Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type {
  ExistingNoteSelection,
  NoteTappedEvent,
  TextSelectedEvent,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"
import type { SelectionActionEvent } from "@shruti/composables/transcript/useTranscriptSelectionActions.js"

export interface TranscriptDialogState {
  readonly isOpen: Ref<boolean>
  readonly title: Ref<string>
  readonly author: Ref<string>
  readonly description: ComputedRef<string | null>
  readonly chapters: ComputedRef<readonly TrackOutlineChapter[]>
  readonly availableLanguages: ComputedRef<readonly UiTranscriptLanguage[]>
  onTranslateLanguage(code: string): Promise<void>
  readonly activeLanguages: Ref<readonly LanguageCode[]>
  readonly blockGroups: ComputedRef<readonly UiTranscriptBlocksGroup[]>
  readonly position: ComputedRef<number>
  readonly duration: ComputedRef<number>
  readonly isLoading: Ref<boolean>
  readonly error: Ref<string | null>
  readonly hasNoTranscripts: ComputedRef<boolean>
  readonly allowMultipleLanguages: Ref<boolean>
  /**
   * Languages whose transcript actually holds a dialogue — i.e. more than one
   * distinct speaker. Drives the per-line speaker icon and the speaker-change
   * dash/newline, which are noise on a monologue. Evaluated per language, so a
   * single-speaker English side stays clean beside a multi-speaker Russian one.
   */
  readonly multiSpeakerLanguages: ComputedRef<ReadonlySet<string>>
  readonly highlightCurrentSentence: Ref<boolean>
  readonly autoScrollCfg: Ref<boolean>
  /**
   * True when the dialog mirrors the track currently loaded in the
   * player. Drives both seek and the prompter scaling effect — both
   * only make sense when there's a live `position`.
   */
  readonly mirrorsActivePlayer: ComputedRef<boolean>
  /**
   * Live drag-select payload — set by `onTextSelected`, cleared on
   * popover action/dismiss. `App.vue` binds this to the sibling
   * `TranscriptSelectionPopover.selection` prop (see App.vue for the
   * rationale behind the sibling-mount design).
   */
  readonly lastTextSelectedEvent: Ref<TextSelectedEvent | undefined>
  /** Tap-on-existing-highlight payload. Same lifecycle as `lastTextSelectedEvent`. */
  readonly lastNoteTappedEvent: Ref<ExistingNoteSelection | undefined>
  onClose(): void
  onSeek(positionMs: number): void
  /** Chapter tapped: seek + start/resume playback (loading the track first
   *  when the transcript was opened in preview mode). */
  onChapterSeek(positionMs: number): Promise<void>
  onTextSelected(event: TextSelectedEvent): void
  onNoteTapped(event: NoteTappedEvent): void
  onSelectionAction(event: SelectionActionEvent): Promise<void>
  onSelectionDismissed(): void
  onPickStart(): void
}
