import type { TrackId } from "@lib/domain/core.js"
import { createNote } from "@lib/application/createNote.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"

export type SelectionActionKind = "copy" | "bookmark" | "share"

export interface SelectionActionEvent {
  action: SelectionActionKind
  text: string
}

export interface UseTranscriptSelectionActionsOptions {
  /** Read at the moment the action fires; `null`/`undefined` is a no-op. */
  getTrackId: () => TrackId | null | undefined
  /** Position (in seconds) used as the timecode for bookmark notes. */
  getPositionSeconds: () => number
  /** Resolved on each call so the composable can be constructed before
   *  the user DB is open. */
  getNotes: () => INoteRepository
  shareService: {
    copyToClipboard(text: string): Promise<void>
    share(input: { text: string }): Promise<void>
  }
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
  async function perform(event: SelectionActionEvent): Promise<void> {
    const trackId = options.getTrackId()
    if (!trackId) return

    if (event.action === "copy") {
      await options.shareService.copyToClipboard(event.text)
      return
    }
    if (event.action === "bookmark") {
      const seconds = Math.max(0, Math.round(options.getPositionSeconds()))
      const result = await createNote(
        { trackId, text: event.text, timeStart: seconds, timeEnd: seconds },
        { notes: options.getNotes() }
      )
      if (!result.ok) options.onError?.(`Could not save note: ${result.error}`)
      return
    }
    if (event.action === "share") {
      await options.shareService.share({ text: event.text })
    }
  }

  return { perform }
}
