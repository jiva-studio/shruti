import type { IRemoteFilesStorage, IStoragePublicUrl } from "@ports/app/index.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"

interface RawTranscript {
  readonly version?: number
  readonly blocks?: TranscriptBlock[]
}

export interface TranscriptRepositoryDeps {
  /**
   * Domain port — the HTTP repo stays ignorant of the content DB's
   * row shapes. It only asks "what path does track X at language Y
   * advertise?" and leaves the SQL to `@infra/repositories/sql`.
   */
  readonly tracks: ITrackRepository
  readonly filesStorage: IRemoteFilesStorage
  readonly storagePublicUrl: IStoragePublicUrl
}

/**
 * HTTP-backed implementation of ITranscriptRepository.
 *
 * - Language availability comes from the track repository (domain port).
 * - Fetching uses the same `IRemoteFilesStorage` + `IStoragePublicUrl`
 *   pipeline as audio/images, so transcripts are cached on disk after
 *   the first open.
 */
export function createHttpTranscriptRepository(
  deps: TranscriptRepositoryDeps
): ITranscriptRepository {
  return {
    availableLanguages(trackId: TrackId): Promise<readonly LanguageCode[]> {
      return deps.tracks.listTranscriptLanguages(trackId)
    },

    async has(trackId: TrackId, language: LanguageCode): Promise<boolean> {
      return (await deps.tracks.getTranscriptPath(trackId, language)) !== null
    },

    async get(trackId: TrackId, language: LanguageCode): Promise<Transcript> {
      const path = await deps.tracks.getTranscriptPath(trackId, language)
      if (!path) {
        throw new Error(`No transcript advertised for (${trackId}, ${language})`)
      }
      const url = deps.storagePublicUrl.get(path)
      const localUrl = await deps.filesStorage.get(url)
      const response = await fetch(localUrl)
      if (!response.ok) {
        throw new Error(`Transcript fetch failed: ${response.status} ${response.statusText}`)
      }
      let raw: RawTranscript
      try {
        raw = (await response.json()) as RawTranscript
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
        throw new Error(`Transcript JSON is malformed at ${path}: ${message}`, { cause: parseErr })
      }
      return {
        trackId,
        language,
        version: raw.version ?? 1,
        blocks: raw.blocks ?? [],
      }
    },
  }
}
