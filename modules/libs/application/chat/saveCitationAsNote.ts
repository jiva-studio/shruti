import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"
import { createNote } from "../createNote.js"
import { loadTranscript, type LoadTranscriptError } from "../loadTranscript.js"

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

export type SaveCitationAsNoteError =
  | "empty-text"
  | "create-note-failed"
  | LoadTranscriptError

export interface SaveCitationAsNoteDeps {
  readonly notes: INoteRepository
  readonly transcripts: ITranscriptRepository
}

/**
 * Save a citation chip's audio span as a user note. The note body is
 * the WORDS the speaker said in that span (sentence blocks overlapping
 * [startMs; endMs]), not the chip's short caption — captions are
 * topic labels, not quotable text. If transcript fetch fails or the
 * overlap is empty we fall back to the caption rather than leave the
 * note blank.
 *
 * Reentrancy is the caller's concern (UI button disables itself during
 * the in-flight call) — this use-case doesn't lock, which makes it
 * trivially testable with a mocked repo + transcript.
 */
export async function saveCitationAsNote(
  input: SaveCitationAsNoteInput,
  deps: SaveCitationAsNoteDeps
): Promise<Result<Note, SaveCitationAsNoteError>> {
  const startMs = Math.max(0, input.startMs)
  const endMs = Math.max(startMs, input.endMs)
  // Preloaded snippet text wins — it's the exact fragment the server
  // already resolved (chat cite_transcript), so we don't need (and may
  // not be able) to re-derive it from a local transcript.
  let text = input.text?.trim() ?? ""

  // Transcript-based note text: every sentence block that overlaps
  // [startMs; endMs] contributes. Block intersects when block.end >=
  // startMs AND block.start <= endMs (closed interval). Skipped when we
  // already have preloaded text.
  if (!text) {
    try {
      const result = await loadTranscript(
        { trackId: input.trackId, preferredLanguage: input.preferredLanguage },
        { transcripts: deps.transcripts }
      )
      if (result.ok) {
        const parts: string[] = []
        for (const b of result.value.transcript.blocks) {
          if (b.type !== "sentence") continue
          if (b.end >= startMs && b.start <= endMs) {
            const trimmed = b.text.trim()
            if (trimmed) parts.push(trimmed)
          }
        }
        text = parts.join(" ")
      }
    } catch {
      // Fall through — caption fallback below.
    }
  }

  if (!text) text = input.caption.trim()
  if (!text) return err("empty-text")

  const created = await createNote(
    {
      trackId: input.trackId,
      text,
      timeStart: startMs,
      timeEnd: endMs,
    },
    { notes: deps.notes }
  )
  if (!created.ok) return err("create-note-failed")
  return ok(created.value)
}
