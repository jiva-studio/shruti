import type { LoadTranscriptError } from "@usecases/playback/loadTranscript.js"
import type { CreateNoteError } from "@usecases/notes/createNote.js"
import type { DeleteNoteError } from "@usecases/notes/deleteNote.js"

/**
 * The `Result` error unions of the reader's use cases, mapped to i18n keys.
 *
 * These codes used to reach the user verbatim, interpolated into a hardcoded
 * English sentence — "Transcript failed to load: fetch-failed", "Could not save
 * note: text-too-long" (#1845). The worst of them replaces the entire reader
 * body, so a Russian reader met a full screen of English naming an internal
 * enum.
 *
 * Kept as one pure module so the mapping is exhaustive by the type checker and
 * testable without a Vue mount: adding a member to any of the three unions
 * fails compilation here rather than shipping a raw code to a user.
 */

/** The reader failed to load the transcript document, with nothing left to
 *  read — this key becomes the whole content of the reader. */
export function transcriptLoadErrorKey(error: LoadTranscriptError): string {
  switch (error) {
    case "fetch-failed":
      return "transcript.loadError.fetchFailed"
    case "language-not-available":
      return "transcript.loadError.languageNotAvailable"
    // The loader treats this as a successful empty load and shows its empty
    // state instead; mapped anyway so the union stays exhaustive.
    case "no-transcript-available":
      return "transcript.loadError.notAvailable"
  }
}

/** A bookmark the reader could not save. */
export function noteSaveErrorKey(error: CreateNoteError): string {
  switch (error) {
    case "empty-text":
      return "notes.saveError.emptyText"
    case "text-too-long":
      return "notes.saveError.textTooLong"
    case "invalid-timestamps":
      return "notes.saveError.invalidRange"
    case "write-failed":
      return "notes.saveError.writeFailed"
  }
}

/** A note the reader could not delete. */
export function noteDeleteErrorKey(error: DeleteNoteError): string {
  switch (error) {
    case "not-found":
      return "notes.deleteError.notFound"
  }
}
