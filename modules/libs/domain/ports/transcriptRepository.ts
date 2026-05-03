import type { LanguageCode, TrackId } from "../core.js"
import type { Transcript } from "../transcript.js"

export interface ITranscriptRepository {
  /** Fetches the transcript for a given (track, language). Throws on network failure. */
  get(trackId: TrackId, language: LanguageCode): Promise<Transcript>
  /** Returns true if a transcript file is advertised in the content DB. */
  has(trackId: TrackId, language: LanguageCode): Promise<boolean>
  /** Languages for which the given track has a transcript. */
  availableLanguages(trackId: TrackId): Promise<readonly LanguageCode[]>
}
