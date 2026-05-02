import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export interface TrackControllerOptions {
  readonly trackId: string
}

export interface TrackControllerReturn {
  track: Ref<Track | null>
  title: ComputedRef<string>
  authorName: ComputedRef<string>
  hasAudio: ComputedRef<boolean>
  availableLanguages: Ref<readonly LanguageCode[]>
  selectedLanguage: Ref<LanguageCode | null>
  error: Ref<string | null>
  onLanguageChange: (language: LanguageCode) => void
  onPlay: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/*                                Controller                                  */
/* -------------------------------------------------------------------------- */

export function useTrackController(options: TrackControllerOptions): TrackControllerReturn {
  const { trackId } = options
  const appLanguage = useAppLanguage()

  const app = useLectorium()
  const repos = app.repositories()
  const player = usePlayerStore()
  const { t } = useI18n()

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const selectedLanguage = ref<LanguageCode | null>(null)
  const error = ref<string | null>(null)

  const title = computed(() => {
    if (!track.value) return ""
    const lang = selectedLanguage.value ?? appLanguage.value
    const variant = track.value.variants.find((v) => v.language === lang) ?? track.value.variants[0]
    return variant?.title ?? track.value.id
  })

  const authorName = computed(() => {
    if (!author.value) return track.value?.authorId ?? ""
    const lang = selectedLanguage.value ?? appLanguage.value
    return (
      author.value.names.get(lang) ?? author.value.names.values().next().value ?? author.value.id
    )
  })

  const hasAudio = computed(() => track.value?.variants.some((v) => v.audio !== null) ?? false)

  async function loadEverything(): Promise<void> {
    error.value = null
    track.value = await repos.tracks.getById(trackId)
    if (!track.value) {
      error.value = t("errors.trackNotFound")
      return
    }
    if (track.value.authorId) {
      author.value = await repos.authors.getById(track.value.authorId)
    } else {
      author.value = null
    }
    availableLanguages.value = await repos.transcripts.availableLanguages(trackId)
    selectedLanguage.value =
      availableLanguages.value.find((l) => l === appLanguage.value) ??
      availableLanguages.value[0] ??
      null
  }

  function onLanguageChange(language: LanguageCode): void {
    selectedLanguage.value = language
  }

  async function onPlay(): Promise<void> {
    if (!track.value) return
    const lang = selectedLanguage.value ?? appLanguage.value
    await player.openTrack({
      track: track.value,
      preferredLanguage: lang,
      author: author.value,
    })
  }

  onMounted(() => {
    void loadEverything()
  })

  return {
    track,
    title,
    authorName,
    hasAudio,
    availableLanguages,
    selectedLanguage,
    error,
    onLanguageChange,
    onPlay,
  }
}
