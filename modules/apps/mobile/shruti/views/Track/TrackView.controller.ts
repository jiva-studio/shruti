import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { loadTranscript } from "@lib/application/loadTranscript.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { useShruti } from "@shruti/shruti.js"
import { buildTranscriptViewData } from "@shruti/composables/buildTranscriptViewData.js"
import type { UiTranscriptBlock } from "@ui/features/transcript/index.js"

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export interface TrackControllerOptions {
  readonly trackId: string
  readonly preferredLanguage?: LanguageCode
}

export interface TrackControllerReturn {
  track: Ref<Track | null>
  title: ComputedRef<string>
  authorName: ComputedRef<string>
  availableLanguages: Ref<readonly LanguageCode[]>
  selectedLanguage: Ref<LanguageCode | null>
  transcriptBlocks: ComputedRef<readonly UiTranscriptBlock[]>
  isLoadingTranscript: Ref<boolean>
  error: Ref<string | null>
  onLanguageChange: (language: LanguageCode) => void
  onSeek: (position: number) => void
}

/* -------------------------------------------------------------------------- */
/*                                Controller                                  */
/* -------------------------------------------------------------------------- */

export function useTrackController(options: TrackControllerOptions): TrackControllerReturn {
  const { trackId, preferredLanguage = "en" } = options

  const app = useShruti()
  const repos = app.repositories()

  /* ---- State ---- */

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const selectedLanguage = ref<LanguageCode | null>(null)
  const transcript = ref<Transcript | null>(null)
  const isLoadingTranscript = ref<boolean>(false)
  const error = ref<string | null>(null)

  /* ---- Race guard ---- */

  // Monotonic token per language switch — stale responses refuse to
  // overwrite state after a newer request was issued.
  let transcriptToken = 0

  /* ---- Derived ---- */

  const title = computed(() => {
    if (!track.value) return ""
    const lang = selectedLanguage.value ?? preferredLanguage
    const variant = track.value.variants.find((v) => v.language === lang) ?? track.value.variants[0]
    return variant?.title ?? track.value.id
  })

  const authorName = computed(() => {
    if (!author.value) return track.value?.authorId ?? ""
    const lang = selectedLanguage.value ?? preferredLanguage
    return (
      author.value.names.get(lang) ?? author.value.names.values().next().value ?? author.value.id
    )
  })

  const transcriptBlocks = computed(() => buildTranscriptViewData(transcript.value))

  /* ---- Loaders ---- */

  async function loadEverything(): Promise<void> {
    error.value = null
    track.value = await repos.tracks.getById(trackId)
    if (!track.value) {
      error.value = "Track not found."
      return
    }
    author.value = await repos.authors.getById(track.value.authorId)
    availableLanguages.value = await repos.transcripts.availableLanguages(trackId)
    selectedLanguage.value =
      availableLanguages.value.find((l) => l === preferredLanguage) ??
      availableLanguages.value[0] ??
      null
    await loadTranscriptForSelected()
  }

  async function loadTranscriptForSelected(): Promise<void> {
    if (!selectedLanguage.value) {
      transcript.value = null
      return
    }
    const token = ++transcriptToken
    isLoadingTranscript.value = true
    try {
      const result = await loadTranscript(
        { trackId, preferredLanguage: selectedLanguage.value },
        { transcripts: repos.transcripts }
      )
      if (token !== transcriptToken) return
      transcript.value = result.ok ? result.value.transcript : null
      if (!result.ok && result.error !== "no-transcript-available") {
        error.value = `Transcript failed to load: ${result.error}`
      }
    } finally {
      if (token === transcriptToken) isLoadingTranscript.value = false
    }
  }

  /* ---- Handlers ---- */

  function onLanguageChange(language: LanguageCode): void {
    selectedLanguage.value = language
  }

  function onSeek(position: number): void {
    // Player wiring lands in a follow-up phase; log for now so the
    // interaction is observable in dev builds.
    console.info(`seek requested to ${position}`)
  }

  /* ---- Lifecycle ---- */

  watch(selectedLanguage, () => {
    void loadTranscriptForSelected()
  })

  onMounted(() => {
    void loadEverything()
  })

  return {
    track,
    title,
    authorName,
    availableLanguages,
    selectedLanguage,
    transcriptBlocks,
    isLoadingTranscript,
    error,
    onLanguageChange,
    onSeek,
  }
}
