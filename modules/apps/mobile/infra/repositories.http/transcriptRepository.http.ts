import type { IDatabase, IRemoteFilesStorage, IStoragePublicUrl } from "@ports/app/index.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"
import type { TrackVariantRow } from "@lib/persistence/main"

interface RawTranscript {
  readonly version?: number
  readonly blocks?: TranscriptBlock[]
}

export interface TranscriptRepositoryDeps {
  readonly contentDb: IDatabase
  readonly filesStorage: IRemoteFilesStorage
  readonly storagePublicUrl: IStoragePublicUrl
}

/**
 * HTTP-backed implementation of ITranscriptRepository.
 *
 * - Language availability comes from the content DB's `track_variants`
 *   rows with a non-null `transcript_path`.
 * - Fetching uses the same `IRemoteFilesStorage` + `IStoragePublicUrl`
 *   pipeline as audio/images, so transcripts are cached on disk after
 *   the first open.
 */
export function createHttpTranscriptRepository(
  deps: TranscriptRepositoryDeps
): ITranscriptRepository {
  async function readTranscriptPath(
    trackId: TrackId,
    language: LanguageCode
  ): Promise<string | null> {
    const rows = await deps.contentDb.query<TrackVariantRow>(
      "SELECT transcript_path FROM track_variants WHERE track_id = ? AND language = ? LIMIT 1",
      [trackId, language]
    )
    return rows[0]?.transcript_path ?? null
  }

  return {
    async availableLanguages(trackId: TrackId): Promise<readonly LanguageCode[]> {
      const rows = await deps.contentDb.query<{ language: string }>(
        `SELECT language FROM track_variants
         WHERE track_id = ? AND transcript_path IS NOT NULL
         ORDER BY language ASC`,
        [trackId]
      )
      return rows.map((r) => r.language)
    },

    async has(trackId: TrackId, language: LanguageCode): Promise<boolean> {
      return (await readTranscriptPath(trackId, language)) !== null
    },

    async get(trackId: TrackId, language: LanguageCode): Promise<Transcript> {
      const path = await readTranscriptPath(trackId, language)
      if (!path) {
        throw new Error(`No transcript advertised for (${trackId}, ${language})`)
      }
      const url = deps.storagePublicUrl.get(path)
      const localUrl = await deps.filesStorage.get(url)
      const response = await fetch(localUrl)
      if (!response.ok) {
        throw new Error(`Transcript fetch failed: ${response.status} ${response.statusText}`)
      }
      const raw = (await response.json()) as RawTranscript
      return {
        trackId,
        language,
        version: raw.version ?? 1,
        blocks: raw.blocks ?? [],
      }
    },
  }
}
