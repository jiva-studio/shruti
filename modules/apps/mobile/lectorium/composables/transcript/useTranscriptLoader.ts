import { ref, type Ref } from "vue"
import { loadTranscript } from "@usecases/playback/loadTranscript.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Transcript } from "@lib/domain/transcript.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"

export interface UseTranscriptLoaderOptions {
  /** Resolved on each call so the composable can be constructed before
   *  the content DB is open. */
  getTranscripts: () => ITranscriptRepository
}

export interface UseTranscriptLoaderReturn {
  transcript: Ref<Transcript | null>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  /** Loads (or clears) the transcript for a `(trackId, language)` pair.
   *  A monotonic token ensures stale responses are dropped. */
  reload: (trackId: TrackId | undefined, language: LanguageCode | undefined) => Promise<void>
}

/**
 * Owns the asynchronous load of a transcript document. Uses a monotonic
 * token so a slow earlier request never overwrites a faster newer one.
 * "no-transcript-available" is treated as a successful empty load
 * rather than an error so the dialog can show its empty state.
 */
export function useTranscriptLoader(
  options: UseTranscriptLoaderOptions
): UseTranscriptLoaderReturn {
  const transcript = ref<Transcript | null>(null)
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loadToken = 0

  async function reload(
    trackId: TrackId | undefined,
    language: LanguageCode | undefined
  ): Promise<void> {
    if (!trackId || !language) {
      transcript.value = null
      return
    }
    const token = ++loadToken
    isLoading.value = true
    try {
      const result = await loadTranscript(
        { trackId, preferredLanguage: language },
        { transcripts: options.getTranscripts() }
      )
      if (token !== loadToken) return
      if (result.ok) {
        transcript.value = result.value.transcript
      } else {
        transcript.value = null
        if (result.error !== "no-transcript-available") {
          error.value = `Transcript failed to load: ${result.error}`
        }
      }
    } finally {
      if (token === loadToken) isLoading.value = false
    }
  }

  return { transcript, isLoading, error, reload }
}
