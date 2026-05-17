import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import { createNote, type CreateNoteError } from "../createNote.js"

export interface SaveChatNoteInput {
  readonly trackId: TrackId
  readonly text: string
  readonly startMs: number
  readonly endMs: number
  /** Server-issued chat action id (hex token). Used to derive a stable
   *  note id so a re-tap on the action card after a flaky network is a
   *  no-op rather than a duplicate row. */
  readonly chatActionId: string
}

export interface SaveChatNoteDeps {
  readonly notes: INoteRepository
}

/**
 * Persist a quote-as-note arriving from a chat `save_note` action.
 *
 * The deterministic-id derivation lives here (not at the call site) so
 * every "save this chat-suggested quote" path lands on the same id
 * scheme. Re-tapping the card → same id → repo's INSERT idempotent
 * path returns the existing row.
 */
export async function saveChatNote(
  input: SaveChatNoteInput,
  deps: SaveChatNoteDeps
) {
  const id = `note_chat_${input.chatActionId}` as NoteId
  return createNote(
    {
      id,
      trackId: input.trackId,
      text: input.text,
      timeStart: Math.max(0, input.startMs),
      timeEnd: Math.max(input.startMs, input.endMs),
    },
    { notes: deps.notes }
  )
}

export type SaveChatNoteError = CreateNoteError
