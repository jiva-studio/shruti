import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import { ok, type Result } from "@lib/domain/result.js"

export interface RemoveDownloadedTranscriptsInput {
  readonly trackId: TrackId
}

/**
 * Per-language uncache callback. The use case stays layer-pure (no
 * adapter imports) by delegating the actual filesystem/CacheStorage
 * delete to a function the caller composes from `IRemoteFilesStorage`
 * + `IStoragePublicUrl`.
 */
export type TranscriptDeleteFn = (
  trackId: TrackId,
  language: LanguageCode
) => Promise<void>

export interface RemoveDownloadedTranscriptsDeps {
  readonly transcripts: ITranscriptRepository
  readonly deleteLocal: TranscriptDeleteFn
}

export interface RemoveDownloadedTranscriptsOutcome {
  readonly removed: readonly LanguageCode[]
}

/**
 * Drop every cached transcript for `trackId`. Mirrors the audio-side
 * `removeDownloadedMedia` so "Remove from offline" cleans up the same
 * bytes we wrote when the track was saved.
 *
 * Failures from `deleteLocal` are tolerated per-language — orphaned
 * cache entries are harmless and the next `clearAll()` (Settings →
 * Clear cache) will sweep them. We never bubble; this is best-effort
 * cleanup, not a verification step.
 *
 * Returning `err` would force every audio-removal call site to handle
 * a transcript-side failure that the user can't act on — so the use
 * case always succeeds. The list of languages we *attempted* comes back
 * for logging/telemetry.
 */
export async function removeDownloadedTranscripts(
  input: RemoveDownloadedTranscriptsInput,
  deps: RemoveDownloadedTranscriptsDeps
): Promise<Result<RemoveDownloadedTranscriptsOutcome, never>> {
  let advertised: readonly LanguageCode[]
  try {
    advertised = await deps.transcripts.availableLanguages(input.trackId)
  } catch {
    // Track DB unavailable — nothing we can do here. Returning an empty
    // outcome is honest (we removed nothing) and keeps the audio remove
    // path going.
    return ok({ removed: [] })
  }

  const removed: LanguageCode[] = []
  for (const language of advertised) {
    try {
      await deps.deleteLocal(input.trackId, language)
      removed.push(language)
    } catch {
      /* swallow — orphan cache entry, see fn comment */
    }
  }
  return ok({ removed })
}
