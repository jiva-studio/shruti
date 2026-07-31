import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useRoute } from "vue-router"
import { useI18n } from "vue-i18n"
import { loadTrackDetail } from "@usecases/playback/loadTrackDetail.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { resolveTrackAuthorName } from "@lib/domain/services/trackAuthor.js"
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
  const libraryLanguages = useLibraryLanguages()

  const app = useLectorium()
  const repos = app.repositories()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const route = useRoute()
  const { t } = useI18n()

  // Deep-link timecode: when the route carries `?resumeFromMs=…` (chat
  // citation chip), auto-open the audio at that position once the
  // track has loaded. Plain navigations have no query and stay on the
  // existing manual-play behaviour.
  const resumeFromMs = parseResumeFromMs(route.query.resumeFromMs)

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const selectedLanguage = ref<LanguageCode | null>(null)
  const error = ref<string | null>(null)

  // The track's content language (a library language it has) — drives the title,
  // the default transcript and playback. Labels (author name) follow the UI.
  const contentLang = computed<LanguageCode>(
    () =>
      (track.value
        ? preferredContentLanguage(track.value, libraryLanguages.value, appLanguage.value)
        : undefined) ?? appLanguage.value
  )

  const title = computed(() => {
    if (!track.value) return ""
    const lang = selectedLanguage.value ?? contentLang.value
    return resolveTrackTitle(track.value, lang) ?? track.value.id
  })

  // Resolve the corpus author entity, else fall back to the raw author label an
  // ingested personal-library track carries — the same helper the track rows /
  // native queue use, so the FloatingPlayer can't show a blank author for a
  // lecture whose card shows one.
  const authorName = computed(() => {
    if (!track.value) return ""
    return resolveTrackAuthorName(track.value, author.value, appLanguage.value)
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
        libraryItems: repos.libraryItems,
      }
    )
    if (!detail.ok) {
      error.value = t("errors.trackNotFound")
      return
    }
    track.value = detail.value.track
    author.value = detail.value.author
    availableLanguages.value = detail.value.availableLanguages
    const preferred = preferredContentLanguage(
      detail.value.track,
      libraryLanguages.value,
      appLanguage.value
    )
    selectedLanguage.value =
      availableLanguages.value.find((l) => l === preferred) ?? availableLanguages.value[0] ?? null
  }

  function onLanguageChange(language: LanguageCode): void {
    selectedLanguage.value = language
  }

  async function onPlay(): Promise<void> {
    if (!track.value) return
    const lang = selectedLanguage.value ?? contentLang.value
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
    void loadEverything().then(async () => {
      if (resumeFromMs !== null && track.value) {
        const lang = selectedLanguage.value ?? contentLang.value
        const entry = playlist.getEntryByTrackId(track.value.id)
        await player.openTrack({
          track: track.value,
          preferredLanguage: lang,
          author: author.value,
          itemId: entry?.item.id,
          resumeFromMs,
        })
      }
    })
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

function parseResumeFromMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
