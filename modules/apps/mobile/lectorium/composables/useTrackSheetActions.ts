import { computed, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useShareTrack } from "@lectorium/composables/useShareTrack.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useTrackSheetStore } from "@lectorium/stores/useTrackSheetStore.js"

/**
 * The Track sheet's footer actions: the state-dependent primary button
 * (add-to-playlist, or "Download again" when a download has failed) and Share.
 * Split out of `TrackSheet.vue` so the component keeps only presentation.
 */
export function useTrackSheetActions(track: Ref<Track | null>) {
  const { t } = useI18n()
  const sheet = useTrackSheetStore()
  const downloads = useDownloadStore()
  const playlist = usePlaylistStore()
  const { addToPlaylist } = useAddToPlaylist()
  const { presentShareMenu } = useShareTrack()

  // A failed/stuck download turns the primary button into a "Download again"
  // retry — the row no longer retries on tap, so the sheet is where the user
  // recovers from a download error.
  const downloadFailed = computed(
    () => sheet.trackId !== null && downloads.getState(sheet.trackId as TrackId) === "failed"
  )
  // The "Add to playlist" action is disabled once the track is already there —
  // the playlist usecase rejects a duplicate add, so there is nothing to do. A
  // failed download takes priority (the track is in the playlist but still needs
  // a retry), so it stays actionable as "Download again".
  const alreadyInPlaylist = computed(
    () => sheet.trackId !== null && playlist.hasTrack(sheet.trackId)
  )
  const primaryActionLabel = computed(() => {
    if (downloadFailed.value) return t("search.actions.downloadAgain")
    if (alreadyInPlaylist.value) return t("search.actions.alreadyInPlaylist")
    return t("search.actions.addToPlaylist")
  })

  function onPrimaryAction(): void {
    if (downloadFailed.value) {
      onDownloadAgain()
      return
    }
    onAddToPlaylist()
  }

  function onAddToPlaylist(): void {
    const id = sheet.trackId
    if (!id) return
    void addToPlaylist(id)
    sheet.close()
  }

  function onDownloadAgain(): void {
    const id = sheet.trackId
    if (!id) return
    // Re-run the audio download for the first variant that has one;
    // `ensureDownloaded` takes the retry path off the "failed" state.
    const audioVariant = track.value?.variants.find((v) => v.audio)
    if (audioVariant?.audio) {
      void downloads.ensureDownloaded(id as TrackId, audioVariant.audio.path)
    }
    sheet.close()
  }

  function onShare(): void {
    const id = sheet.trackId
    if (!id) return
    // Sharing is free; only the PDF export inside the menu is Pro-gated.
    void presentShareMenu(id)
  }

  return { downloadFailed, alreadyInPlaylist, primaryActionLabel, onPrimaryAction, onShare }
}
