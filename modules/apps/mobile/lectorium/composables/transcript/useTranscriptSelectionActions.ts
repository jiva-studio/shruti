import type { TrackId } from "@lib/domain/core.js"
import { createNote } from "@lib/application/createNote.js"
import { formatNoteShare, type NoteShareContext } from "@lib/application/formatNoteShare.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"

export type SelectionActionKind = "copy" | "bookmark" | "share"

export interface SelectionActionEvent {
  action: SelectionActionKind
  text: string
  /** Start of the selected text range, in **milliseconds** (matches the
   *  `data-time-start` attribute on the dragged blocks). */
  timeStart: number
  /** End of the selected text range, in **milliseconds**. */
  timeEnd: number
}

export interface UseTranscriptSelectionActionsOptions {
  /** Read at the moment the action fires; `null`/`undefined` is a no-op. */
  getTrackId: () => TrackId | null | undefined
  /** Resolved on each call so the composable can be constructed before
   *  the user DB is open. */
  getNotes: () => INoteRepository
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
  /** Surface a load/save error back to the consumer. */
  onError?: (message: string) => void
}

export interface UseTranscriptSelectionActionsReturn {
  /** Dispatches the selected action (copy/bookmark/share) on the
   *  current track. */
  perform: (event: SelectionActionEvent) => Promise<void>
}

/**
 * Encapsulates the three things a transcript-selection popover can do:
 * copy text to clipboard, save a bookmark note, share via the platform
 * sheet. Side-effecting deps are injected so the composable is testable.
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
    }
  }

  return { perform }
}
