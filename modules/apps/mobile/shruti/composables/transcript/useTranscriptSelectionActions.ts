import type { NoteId, TrackId } from "@lib/domain/core.js"
import { createNote } from "@usecases/notes/createNote.js"
import { deleteNote } from "@usecases/notes/deleteNote.js"
import { formatNoteShare, type NoteShareContext } from "@usecases/notes/formatNoteShare.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"

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
  /** Surface a load/save error back to the consumer. */
  onError?: (message: string) => void
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

  async function perform(event: SelectionActionEvent): Promise<void> {
    const trackId = options.getTrackId()
    if (!trackId) return

    if (event.action === "copy") {
      // Copy from the transcript popover stays bare: mid-listening
      // "copy this sentence into chat" shouldn't drag the bibliographic
      // header along. The notes-page Copy *does* use the share template
      // (separate controller), per user direction.
      await options.shareService.copyToClipboard(event.text)
      return
    }
    if (event.action === "bookmark") {
      // Anchor the bookmark to the selected sentence range, not the
      // current playback head — the user picked a specific span of text.
      const timeStart = Math.max(0, Math.round(event.timeStart))
      const timeEnd = Math.max(timeStart, Math.round(event.timeEnd))
      const result = await createNote(
        { trackId, text: event.text, timeStart, timeEnd },
        { notes: options.getNotes() }
      )
      if (!result.ok) {
        options.onError?.(`Could not save note: ${result.error}`)
        return
      }
      options.onNoteCreated?.()
      return
    }
    if (event.action === "share") {
      await options.shareService.share({ text: buildShareText(event) })
      return
    }
    if (event.action === "delete") {
      // Tap-on-highlight Delete. The popover always sends at least one
      // id in this branch (the renderer only emits `noteTapped` when
      // `block.noteIds.length > 0`), but stay defensive — a stale
      // payload after the underlying notes refreshed could in principle
      // arrive empty.
      const id = event.noteIds?.[0]
      if (!id) return
      const result = await deleteNote(
        { id },
        { notes: options.getNotes(), unitOfWork: options.getUnitOfWork() }
      )
      if (!result.ok) {
        options.onError?.(`Could not delete note: ${result.error}`)
        return
      }
      options.onNoteDeleted?.()
      return
    }
    if (event.action === "ask") {
      // Two arrival paths:
      //  - selection: `event.text` + `event.timeStart` / `timeEnd` come
      //    straight from the drag. Use as-is.
      //  - existing (tap-on-highlight): popover forwards empty text +
      //    zero range; the real values live on the note row, so we
      //    fetch it here. Keeps the consumer ignorant of the two paths.
      let text = event.text
      let timeStart = event.timeStart
      let timeEnd = event.timeEnd
      if (!text || timeEnd <= timeStart) {
        const noteId = event.noteIds?.[0]
        if (!noteId) return
        try {
          const note = await options.getNotes().getById(noteId)
          if (!note) return
          text = note.text
          timeStart = note.timeStart
          timeEnd = note.timeEnd
        } catch (err) {
          options.onError?.(
            `Could not load note: ${err instanceof Error ? err.message : String(err)}`
          )
          return
        }
      }
      if (!text) return
      const normalisedStart = Math.max(0, Math.round(timeStart))
      await options.onAskRequested?.({
        trackId,
        text,
        timeStart: normalisedStart,
        timeEnd: Math.max(normalisedStart + 1, Math.round(timeEnd)),
      })
      return
    }
  }

  return { perform }
}
