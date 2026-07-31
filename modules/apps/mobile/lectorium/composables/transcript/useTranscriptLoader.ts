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

/** One loaded language + its transcript document, in the order the languages
 *  were requested. Time-merged into the view by `buildMergedTranscriptViewData`. */
export interface LoadedTranscript {
  readonly language: LanguageCode
  readonly transcript: Transcript
}

export interface UseTranscriptLoaderReturn {
  transcripts: Ref<readonly LoadedTranscript[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  /** Loads (or clears) the transcripts for a track's active languages. Each is
   *  fetched in parallel; a monotonic token ensures stale responses are dropped.
   *  Languages with no transcript are simply omitted. */
  reload: (trackId: TrackId | undefined, languages: readonly LanguageCode[]) => Promise<void>
}

/**
 * Owns the asynchronous load of a track's transcript documents (one per active
 * language). Uses a monotonic token so a slow earlier request never overwrites
 * a faster newer one. "no-transcript-available" is treated as a successful empty
 * load rather than an error so the dialog can show its empty state.
 */
export function useTranscriptLoader(
  options: UseTranscriptLoaderOptions
): UseTranscriptLoaderReturn {
  const transcripts = ref<readonly LoadedTranscript[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loadToken = 0

  async function reload(
    trackId: TrackId | undefined,
    languages: readonly LanguageCode[]
  ): Promise<void> {
    if (!trackId || languages.length === 0) {
      transcripts.value = []
      return
    }
    const token = ++loadToken
    isLoading.value = true
    try {
      const repo = options.getTranscripts()
      const loaded = await Promise.all(
        languages.map(async (language) => {
          const result = await loadTranscript(
            { trackId, preferredLanguage: language },
            { transcripts: repo }
          )
          if (result.ok) return { language, transcript: result.value.transcript }
          if (result.error !== "no-transcript-available") {
            error.value = `Transcript failed to load: ${result.error}`
          }
          return null
        })
      )
      if (token !== loadToken) return
      transcripts.value = loaded.filter((x): x is LoadedTranscript => x !== null)
    } finally {
      if (token === loadToken) isLoading.value = false
    }
  }

  return { transcripts, isLoading, error, reload }
}
