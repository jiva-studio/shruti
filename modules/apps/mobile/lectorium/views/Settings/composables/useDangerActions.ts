import { alertController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import type { Lectorium } from "@lectorium/lectorium.js"

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
 */
export function useDangerActions(app: Lectorium): UseDangerActionsReturn {
  const { t } = useI18n()
  const repos = app.repositories()

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
    await repos.notes.clearAll()
    await repos.playlistItems.clearAll()
    await repos.mediaItems.clearAll()
    await app.preferences.remove("search.filters.v2")
  }

  return { onClearCache, onClearUserData }
}
