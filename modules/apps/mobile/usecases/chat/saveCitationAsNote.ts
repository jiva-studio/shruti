import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import { err, ok, type Result } from "@kit/core"
import { createNote } from "../notes/createNote.js"
import { loadTranscript, type LoadTranscriptError } from "../playback/loadTranscript.js"
import { quoteTranscriptSpan } from "./quoteTranscriptSpan.js"

export interface SaveCitationAsNoteInput {
  readonly trackId: TrackId
  readonly startMs: number
  readonly endMs: number
  /** Chip caption — shown when the chip rendered. Used as fallback note
   *  text when the transcript fetch fails or the overlap is empty. */
  readonly caption: string
  /** Preloaded snippet text (the chat `cite_transcript` SSE payload).
   *  When present it's used verbatim as the note body — the client may
   *  not hold the track's transcript locally to re-derive it. Absent ⇒
   *  fall through to the transcript fetch / caption. */
  readonly text?: string
  readonly preferredLanguage: LanguageCode
}

export type SaveCitationAsNoteError = "empty-text" | "create-note-failed" | LoadTranscriptError

export interface SaveCitationAsNoteDeps {
  readonly notes: INoteRepository
  readonly transcripts: ITranscriptRepository
}

/**
 * Save a citation chip's audio span as a user note. The note body is the WORDS
 * the speaker said in that span, not the chip's short caption — captions are
 * topic labels, not quotable text. A failed transcript fetch or an empty
 * overlap falls back to the caption rather than leaving the note blank.
 *
 * Reentrancy is the caller's concern (the UI button disables itself during the
 * in-flight call); this use case does not lock.
 */
export async function saveCitationAsNote(
  input: SaveCitationAsNoteInput,
  deps: SaveCitationAsNoteDeps
): Promise<Result<Note, SaveCitationAsNoteError>> {
  const startMs = Math.max(0, input.startMs)
  const endMs = Math.max(startMs, input.endMs)

  // Preloaded snippet text wins — it is the exact fragment the server already
  // resolved, which the client may not be able to re-derive locally.
  let text = input.text?.trim() ?? ""
  if (!text) text = await readSpanQuote(input, deps, startMs, endMs)
  if (!text) text = input.caption.trim()
  if (!text) return err("empty-text")

  const created = await createNote(
    { trackId: input.trackId, text, timeStart: startMs, timeEnd: endMs },
    { notes: deps.notes }
  )
  if (!created.ok) return err("create-note-failed")
  return ok(created.value)
}

/** Empty whenever the transcript is unavailable or the span holds no words —
 *  the caller falls back to the caption either way. */
async function readSpanQuote(
  input: SaveCitationAsNoteInput,
  deps: SaveCitationAsNoteDeps,
  startMs: number,
  endMs: number
): Promise<string> {
  try {
    const result = await loadTranscript(
      { trackId: input.trackId, preferredLanguage: input.preferredLanguage },
      { transcripts: deps.transcripts }
    )
    if (!result.ok) return ""
    return quoteTranscriptSpan(result.value.transcript.blocks, startMs, endMs)
  } catch {
    return ""
  }
}
