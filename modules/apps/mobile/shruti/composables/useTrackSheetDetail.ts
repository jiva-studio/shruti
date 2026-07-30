import { ref, watch } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { preferredContentLanguage } from "@lib/domain/services/localizedName.js"
import { loadTrackDetail } from "@usecases/playback/loadTrackDetail.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"

/**
 * Owns the Track sheet's active-track state and its loading lifecycle: whenever
 * the shared `useTrackSheetStore().trackId` changes it (re-)loads the track,
 * author and raw personal-library fields, defaults the shown transcript
 * language, and clears everything when the sheet closes. Keeps `TrackSheet.vue`
 * free of the imperative fetch orchestration so the component is display-only.
 *
 * `onAfterLoad` fires once a fresh track has landed (used to reset scroll when a
 * "similar lecture" swaps content in the same sheet).
 */
export function useTrackSheetDetail(options: { onAfterLoad?: () => void } = {}) {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const sheet = useTrackSheetStore()
  const overlays = useOverlaysStore()
  const dictionaries = useDictionariesStore()

  const track = ref<Track | null>(null)
  const authorEntity = ref<Author | null>(null)
  const authorRaw = ref<string | null>(null)
  const locationRaw = ref<string | null>(null)
  const selectedLanguage = ref<LanguageCode | null>(null)

  watch(
    () => sheet.trackId,
    async (id) => {
      if (id === null) {
        track.value = null
        authorEntity.value = null
        authorRaw.value = null
        locationRaw.value = null
        selectedLanguage.value = null
        overlays.actionSheetOpen = false
        return
      }
      overlays.actionSheetOpen = true
      void app.haptics.impact("light")
      void dictionaries.ensureLoaded()
      const repos = app.repositories()
      const detail = await loadTrackDetail(
        { trackId: id },
        {
          tracks: repos.tracks,
          authors: repos.authors,
          transcripts: repos.transcripts,
          libraryItems: repos.libraryItems,
        }
      )
      if (!detail.ok) {
        // Genuine not-found for the CURRENT target (not a superseded load):
        // clear so the sheet doesn't keep showing the previously-opened track.
        if (sheet.trackId === id) {
          track.value = null
          authorEntity.value = null
          authorRaw.value = null
          locationRaw.value = null
          selectedLanguage.value = null
        }
        return
      }
      // A newer present() may have superseded this load — drop the stale result.
      if (sheet.trackId !== id) return
      track.value = detail.value.track
      authorEntity.value = detail.value.author
      authorRaw.value = detail.value.authorRaw
      locationRaw.value = detail.value.locationRaw
      // Default the shown transcript to the track's content language (a library
      // language it has), else its first available — the user can still switch.
      const preferred = preferredContentLanguage(
        detail.value.track,
        libraryLanguages.value,
        appLanguage.value
      )
      selectedLanguage.value =
        detail.value.availableLanguages.find((l: LanguageCode) => l === preferred) ??
        detail.value.availableLanguages[0] ??
        null
      options.onAfterLoad?.()
    }
  )

  return { track, authorEntity, authorRaw, locationRaw, selectedLanguage }
}
