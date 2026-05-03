import { useI18n } from "vue-i18n"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useToast } from "@shruti/services/useToast.js"

export interface UseAddToPlaylistReturn {
  /** Idempotent: surfaces a different toast if the track is already queued. */
  addToPlaylist: (trackId: string) => Promise<void>
}

/**
 * Adds a track to the playlist with user-facing toasts. Wraps the store
 * call so view code stays free of toast/i18n wiring.
 */
export function useAddToPlaylist(): UseAddToPlaylistReturn {
  const playlist = usePlaylistStore()
  const toast = useToast()
  const { t } = useI18n()

  async function addToPlaylist(trackId: string): Promise<void> {
    const result = await playlist.add(trackId)
    if (result.ok) {
      await toast.info(t("search.notifications.newTrackAddedToPlaylist"))
    } else if (result.error === "already-in-playlist") {
      await toast.info(t("search.alreadyInPlaylist"))
    }
  }

  return { addToPlaylist }
}
