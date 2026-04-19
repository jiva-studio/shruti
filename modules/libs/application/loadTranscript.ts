import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export type LoadTranscriptError =
  | "language-not-available"
  | "fetch-failed"
  | "no-transcript-available"

export interface LoadTranscriptInput {
  readonly trackId: TrackId
  /**
   * Preferred language. If no transcript is advertised for it, the use
   * case falls back to the first available language.
   */
  readonly preferredLanguage: LanguageCode
}

export interface LoadTranscriptDeps {
  readonly transcripts: ITranscriptRepository
}

export interface LoadedTranscript {
  readonly transcript: Transcript
  readonly availableLanguages: readonly LanguageCode[]
  /** True when the returned language is the preferred one. */
  readonly matchesPreferred: boolean
}

/**
 * Loads a transcript for a track: picks a language (preferred if
 * available, else the first listed), fetches the JSON via the transcript
 * repository, and returns the parsed transcript plus the full language
 * list so the UI can offer a language switcher.
 */
export async function loadTranscript(
  input: LoadTranscriptInput,
  deps: LoadTranscriptDeps
): Promise<Result<LoadedTranscript, LoadTranscriptError>> {
  const languages = await deps.transcripts.availableLanguages(input.trackId)
  if (languages.length === 0) return err("no-transcript-available")

  const language = languages.includes(input.preferredLanguage)
    ? input.preferredLanguage
    : languages[0]

  try {
    const transcript = await deps.transcripts.get(input.trackId, language)
    return ok({
      transcript,
      availableLanguages: languages,
      matchesPreferred: language === input.preferredLanguage,
    })
  } catch {
    return err("fetch-failed")
  }
}
