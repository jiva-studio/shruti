import type { NoteId, TrackId } from "@lib/domain/core.js"
import { createNote } from "@usecases/notes/createNote.js"
import { deleteNote } from "@usecases/notes/deleteNote.js"
import { formatNoteShare, type NoteShareContext } from "@usecases/notes/formatNoteShare.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { noteDeleteErrorKey, noteSaveErrorKey } from "./transcriptErrorKeys.js"

export type SelectionActionKind = "copy" | "bookmark" | "share" | "delete" | "ask"

export interface SelectionActionEvent {
  action: SelectionActionKind
  text: string
  /** Start of the selected text range, in **milliseconds** (matches the
   *  `data-time-start` attribute on the dragged blocks). */
  timeStart: number
  /** End of the selected text range, in **milliseconds**. */
  timeEnd: number
  /**
   * Populated for `delete` (tap-on-highlight) and `ask` when the user
   * tapped an existing note instead of dragging a fresh selection. The
   * `ask` branch reads the first id to pull the note's text + range
   * from the repo (the popover sends `text:""` and `timeStart=0` for
   * the existing-note path).
   */
  noteIds?: readonly NoteId[]
}

/**
 * Argument shape handed to `onAskRequested` by the `'ask'` branch.
 * Narrow on purpose — text + range + trackId. The consumer (typically
 * the transcript dialog controller) is responsible for resolving track
 * metadata + sourceKey + dispatching the chat store + router.
 */
export interface AskRequestParams {
  readonly trackId: TrackId
  readonly text: string
  readonly timeStart: number
  readonly timeEnd: number
}

export interface UseTranscriptSelectionActionsOptions {
  /** Read at the moment the action fires; `null`/`undefined` is a no-op. */
  getTrackId: () => TrackId | null | undefined
  /** Resolved on each call so the composable can be constructed before
   *  the user DB is open. */
  getNotes: () => INoteRepository
  /** Resolved lazily — needed only for the delete path. */
  getUnitOfWork: () => IUnitOfWork
  shareService: {
    copyToClipboard(text: string): Promise<void>
    share(input: { text: string }): Promise<void>
  }
  /**
   * Optional supplier of the surrounding track metadata used to enrich
   * the copy/share text (author, title, date, location, reference).
   * Called at the moment the action fires so the values pick up any
   * language or dictionary changes since the composable was set up.
   * When absent — or when it returns `undefined` — copy/share fall back
   * to a bare quote with the time range.
   */
  getShareTrackContext?: () => NoteShareContext["track"] | undefined
  /** Fires after a bookmark is saved, so the caller can refresh stores
   *  / re-apply highlights to the open transcript. */
  onNoteCreated?: () => void
  /** Fires after a note is deleted via tap-on-highlight Delete, so the
   *  caller can refresh stores / drop the underline from the view. */
  onNoteDeleted?: () => void
  /** Surface a load/save failure back to the consumer as an i18n KEY. It used
   *  to be a hardcoded English sentence with the `Result` error code (or a raw
   *  JS `Error.message`) interpolated into it, shown verbatim to the user
   *  (#1845). */
  onError?: (key: string) => void
  /**
   * Dispatched on `'ask'` actions. The composable normalises the
   * `selection` vs `existing` paths into one params shape — drag-select
   * sends live `event.text`+range; tap-on-highlight resolves the note
   * via `getNotes().getById(noteIds[0])` and forwards its persisted
   * text + range. The consumer wires this to the chat store +
   * navigation; if absent, `'ask'` is a no-op.
   */
  onAskRequested?: (params: AskRequestParams) => Promise<void> | void
}

export interface UseTranscriptSelectionActionsReturn {
  /** Dispatches the selected action (copy/bookmark/share/delete) on the
   *  current track. */
  perform: (event: SelectionActionEvent) => Promise<void>
}

/**
 * Encapsulates the four things a transcript-selection popover can do:
 * copy text to clipboard, save a bookmark note, share via the platform
 * sheet, delete an existing note. Side-effecting deps are injected so the
 * composable is testable.
 */
export function useTranscriptSelectionActions(
  options: UseTranscriptSelectionActionsOptions
): UseTranscriptSelectionActionsReturn {
  function buildShareText(event: SelectionActionEvent): string {
    return formatNoteShare({
      text: event.text,
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
      track: options.getShareTrackContext?.(),
    })
  }

  // Copy from the transcript popover stays bare: mid-listening "copy this
  // sentence into chat" shouldn't drag the bibliographic header along. The
  // notes-page Copy does use the share template.
  async function copySelection(event: SelectionActionEvent): Promise<void> {
    await options.shareService.copyToClipboard(event.text)
  }

  async function shareSelection(event: SelectionActionEvent): Promise<void> {
    await options.shareService.share({ text: buildShareText(event) })
  }

  // Anchored to the selected sentence range, not the playback head — the user
  // picked a specific span of text.
  async function saveBookmark(event: SelectionActionEvent, trackId: TrackId): Promise<void> {
    const timeStart = Math.max(0, Math.round(event.timeStart))
    const timeEnd = Math.max(timeStart, Math.round(event.timeEnd))
    const result = await createNote(
      { trackId, text: event.text, timeStart, timeEnd },
      { notes: options.getNotes() }
    )
    if (!result.ok) {
      options.onError?.(noteSaveErrorKey(result.error))
      return
    }
    options.onNoteCreated?.()
  }

  // Tap-on-highlight Delete. The popover always sends at least one id here,
  // but a stale payload could in principle arrive empty.
  async function deleteTappedNote(event: SelectionActionEvent): Promise<void> {
    const id = event.noteIds?.[0]
    if (!id) return
    const result = await deleteNote(
      { id },
      { notes: options.getNotes(), unitOfWork: options.getUnitOfWork() }
    )
    if (!result.ok) {
      options.onError?.(noteDeleteErrorKey(result.error))
      return
    }
    options.onNoteDeleted?.()
  }

  /**
   * Two arrival paths: a drag-selection carries its own text and range, while
   * tap-on-highlight forwards empty text and a zero range — the real values
   * live on the note row. `null` when nothing askable could be resolved.
   */
  async function resolveAskSelection(
    event: SelectionActionEvent
  ): Promise<{ text: string; timeStart: number; timeEnd: number } | null> {
    if (event.text && event.timeEnd > event.timeStart) {
      return { text: event.text, timeStart: event.timeStart, timeEnd: event.timeEnd }
    }
    const noteId = event.noteIds?.[0]
    if (!noteId) return null
    try {
      const note = await options.getNotes().getById(noteId)
      if (!note) return null
      return { text: note.text, timeStart: note.timeStart, timeEnd: note.timeEnd }
    } catch (err) {
      console.warn("[transcript] could not read the tapped note:", err)
      options.onError?.("notes.openError")
      return null
    }
  }

  async function askAboutSelection(event: SelectionActionEvent, trackId: TrackId): Promise<void> {
    const selection = await resolveAskSelection(event)
    if (!selection?.text) return
    const timeStart = Math.max(0, Math.round(selection.timeStart))
    await options.onAskRequested?.({
      trackId,
      text: selection.text,
      timeStart,
      timeEnd: Math.max(timeStart + 1, Math.round(selection.timeEnd)),
    })
  }

  const handlers: Record<
    SelectionActionKind,
    (event: SelectionActionEvent, trackId: TrackId) => Promise<void>
  > = {
    copy: copySelection,
    bookmark: saveBookmark,
    share: shareSelection,
    delete: deleteTappedNote,
    ask: askAboutSelection,
  }

  async function perform(event: SelectionActionEvent): Promise<void> {
    const trackId = options.getTrackId()
    if (!trackId) return
    await handlers[event.action]?.(event, trackId)
  }

  return { perform }
}
