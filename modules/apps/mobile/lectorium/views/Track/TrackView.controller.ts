import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { loadTrackDetail } from "@lib/application/loadTrackDetail.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lectorium/composables/resolveLocalized.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"

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
  const playlist = usePlaylistStore()
  const { t } = useI18n()

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const selectedLanguage = ref<LanguageCode | null>(null)
  const error = ref<string | null>(null)

  const title = computed(() => {
    if (!track.value) return ""
    const lang = selectedLanguage.value ?? appLanguage.value
    return resolveTrackTitle(track.value, lang) ?? track.value.id
  })

  const authorName = computed(() => {
    if (!author.value) return track.value?.authorId ?? ""
    const lang = selectedLanguage.value ?? appLanguage.value
    return resolveLocalizedName(author.value, lang) ?? author.value.id
  })

  const hasAudio = computed(() => track.value?.variants.some((v) => v.audio !== null) ?? false)

  async function loadEverything(): Promise<void> {
    error.value = null
    const detail = await loadTrackDetail(
      { trackId: trackId as TrackId },
      {
        tracks: repos.tracks,
        authors: repos.authors,
        transcripts: repos.transcripts,
      }
    )
    if (!detail.ok) {
      error.value = t("errors.trackNotFound")
      return
    }
    track.value = detail.value.track
    author.value = detail.value.author
    availableLanguages.value = detail.value.availableLanguages
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
    // If the track is queued in the playlist, resume from saved progress.
    // Otherwise (ad-hoc play from the Track screen) play without
    // persistence — there's no playlist item to write to.
    const entry = playlist.getEntryByTrackId(track.value.id)
    await player.openTrack({
      track: track.value,
      preferredLanguage: lang,
      author: author.value,
      itemId: entry?.item.id,
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
