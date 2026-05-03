import { alertController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import type { Lectorium } from "@lectorium/lectorium.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"

export interface UseDangerActionsReturn {
  /** Wipes the on-disk media cache. Does not touch user records. */
  onClearCache: () => Promise<void>
  /** Confirms with the user, then wipes notes/playlist/media items and
   *  the persisted filter snapshot. Cancels silently if the confirm
   *  dialog isn't acknowledged. */
  onClearUserData: () => Promise<void>
}

/**
 * Bundles the destructive Settings actions so the view stays free of
 * direct repository imports. `onClearUserData` is irreversible (notes,
 * playlist, downloads, filters all gone) so it requires an explicit
 * confirm dialog before running.
 *
 * After the on-disk wipe the in-memory Pinia stores caching user data
 * are also reset/refreshed — without that step, navigating back to
 * Home would still render the old playlist (the entries `ref` is
 * unchanged until something calls `playlist.refresh()` or the app is
 * killed and relaunched).
 */
export function useDangerActions(app: Lectorium): UseDangerActionsReturn {
  const { t } = useI18n()
  const repos = app.repositories()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const notes = useNotesStore()
  const downloads = useDownloadStore()
  const searchFilters = useSearchFiltersStore()

  async function onClearCache(): Promise<void> {
    await app.filesStorage.clearAll()
  }

  async function onClearUserData(): Promise<void> {
    const alert = await alertController.create({
      header: t("settings.danger.confirmClearUserData.header"),
      message: t("settings.danger.confirmClearUserData.message"),
      buttons: [
        { text: t("settings.danger.confirmClearUserData.cancel"), role: "cancel" },
        { text: t("settings.danger.confirmClearUserData.confirm"), role: "destructive" },
      ],
    })
    await alert.present()
    const { role } = await alert.onDidDismiss()
    if (role !== "destructive") return

    // Stop playback first — the audio engine could still be playing a
    // track whose row is about to be deleted, leaving the floating
    // player stuck pointing at a ghost. `stop()` is a no-op when
    // nothing is open, so it's safe to call unconditionally.
    if (player.open) await player.stop()

    // 1. On-disk wipe.
    await repos.notes.clearAll()
    await repos.playlistItems.clearAll()
    await repos.mediaItems.clearAll()
    await app.preferences.remove("search.filters.v2")

    // 2. In-memory Pinia caches that mirror the wiped repos. Without
    //    this, Home/Search/Notes still render the pre-wipe lists until
    //    the next cold start.
    //
    //    - playlist & notes: refresh re-reads the (now empty) repos.
    //    - downloads: drop the per-track state map and force a
    //      re-hydrate from the (now empty) media-items repo on next
    //      access.
    //    - searchFilters: clear in-memory selection without re-writing
    //      preferences (we just removed the key on disk).
    await Promise.all([playlist.refresh(), notes.refresh()])
    downloads.reset()
    searchFilters.reset()
  }

  return { onClearCache, onClearUserData }
}
