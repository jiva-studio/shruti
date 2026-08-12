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
  /** Set only when the transcript DOCUMENT failed to load and NOTHING is left to
   *  read — the reader swaps itself for an error state on it. Action failures
   *  (bookmark, ask, translate, chapter tap) belong in the controller's toast
   *  channel instead, or the whole text disappears under the user (issue #1583).
   *  So does a partial failure — see `failedLanguages`. */
  error: Ref<string | null>
  /** Languages that failed while at least one OTHER language did load. The text
   *  the user has stays on screen and the controller mentions the missing side
   *  in a toast; taking the reader to its error state for the half that is
   *  missing throws away the half that is there (issue #1785). Empty whenever
   *  `error` is set — nothing loaded then, so there is nothing to keep. */
  failedLanguages: Ref<readonly LanguageCode[]>
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
  const failedLanguages = ref<readonly LanguageCode[]>([])
  let loadToken = 0

  async function reload(
    trackId: TrackId | undefined,
    languages: readonly LanguageCode[]
  ): Promise<void> {
    // A load starts from a clean slate: without this the reader stays stuck on
    // the previous failure's error state even after a successful re-read.
    error.value = null
    failedLanguages.value = []
    // Bumped on every entry, the empty path included: clearing the reader has
    // to invalidate whatever is still in flight, or that load lands afterwards
    // and repopulates the dialog the user just closed.
    const token = ++loadToken
    if (!trackId || languages.length === 0) {
      transcripts.value = []
      // The invalidated load's `finally` no longer owns the token, so it will
      // not put the spinner down — do it here.
      isLoading.value = false
      return
    }
    isLoading.value = true
    try {
      const repo = options.getTranscripts()
      // Collected, not published: a failure belongs to the load that produced
      // it, and only the token check below knows whether that load is still
      // the current one.
      const failures: { language: LanguageCode; reason: string }[] = []
      const loaded = await Promise.all(
        languages.map(async (language) => {
          const result = await loadTranscript(
            { trackId, preferredLanguage: language },
            { transcripts: repo }
          )
          if (result.ok) return { language, transcript: result.value.transcript }
          if (result.error !== "no-transcript-available") {
            failures.push({ language, reason: result.error })
          }
          return null
        })
      )
      if (token !== loadToken) return
      const ok = loaded.filter((x): x is LoadedTranscript => x !== null)
      transcripts.value = ok
      if (failures.length === 0) return
      // Nothing to read → the error state is the whole content of the reader.
      // Something to read → keep it, and let the controller say what is missing.
      if (ok.length === 0) error.value = `Transcript failed to load: ${failures[0]!.reason}`
      else failedLanguages.value = failures.map((f) => f.language)
    } finally {
      if (token === loadToken) isLoading.value = false
    }
  }

  return { transcripts, isLoading, error, failedLanguages, reload }
}
