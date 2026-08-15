import { describe, expect, it } from "vitest"
import type { LoadTranscriptError } from "@usecases/playback/loadTranscript.js"
import type { CreateNoteError } from "@usecases/notes/createNote.js"
import type { DeleteNoteError } from "@usecases/notes/deleteNote.js"
import en from "@lectorium/i18n/locales/en/transcript.js"
import enNotes from "@lectorium/i18n/locales/en/notes.js"
import {
  noteDeleteErrorKey,
  noteSaveErrorKey,
  transcriptLoadErrorKey,
} from "../transcriptErrorKeys.js"

/**
 * Issue #1845: these `Result` codes were interpolated into hardcoded English —
 * "Transcript failed to load: fetch-failed" over the whole reader, "Could not
 * save note: text-too-long" in a toast. This pins the mapping AND that every
 * key it produces actually resolves in the reference locale, since a key that
 * doesn't is just a different string of English on the same screen.
 */

function resolve(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object") return (node as Record<string, unknown>)[part]
    return undefined
  }, bundle)
}

const LOAD_ERRORS: LoadTranscriptError[] = [
  "fetch-failed",
  "language-not-available",
  "no-transcript-available",
]
const SAVE_ERRORS: CreateNoteError[] = [
  "empty-text",
  "text-too-long",
  "invalid-timestamps",
  "write-failed",
]
const DELETE_ERRORS: DeleteNoteError[] = ["not-found"]

describe("transcriptLoadErrorKey", () => {
  it("names the fetch failure and the missing language apart", () => {
    expect(transcriptLoadErrorKey("fetch-failed")).toBe("transcript.loadError.fetchFailed")
    expect(transcriptLoadErrorKey("language-not-available")).toBe(
      "transcript.loadError.languageNotAvailable"
    )
  })

  it.each(LOAD_ERRORS)("resolves %s to a real English string", (error) => {
    const key = transcriptLoadErrorKey(error)
    expect(typeof resolve(en, key.replace(/^transcript\./, ""))).toBe("string")
  })
})

describe("noteSaveErrorKey", () => {
  it("gives each rejection its own sentence", () => {
    expect(new Set(SAVE_ERRORS.map(noteSaveErrorKey)).size).toBe(SAVE_ERRORS.length)
  })

  it.each(SAVE_ERRORS)("resolves %s to a real English string", (error) => {
    const key = noteSaveErrorKey(error)
    expect(typeof resolve(enNotes, key.replace(/^notes\./, ""))).toBe("string")
  })
})

describe("noteDeleteErrorKey", () => {
  it.each(DELETE_ERRORS)("resolves %s to a real English string", (error) => {
    const key = noteDeleteErrorKey(error)
    expect(typeof resolve(enNotes, key.replace(/^notes\./, ""))).toBe("string")
  })
})
