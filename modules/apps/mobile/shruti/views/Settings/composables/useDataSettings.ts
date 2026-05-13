import { alertController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import type { Shruti } from "@shruti/shruti.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"

export interface UseDataSettingsReturn {
  /** Trigger an OS share-sheet (native) / browser download (web) of the user DB. */
  onExportDatabase: () => Promise<void>
  /** Selected file from the hidden `<input type="file">`. Shows a destructive
   *  confirm dialog, stops the player, then bulk-replaces every user table
   *  and hard-reloads to `/welcome` to re-bootstrap the app. */
  onImportFileSelected: (file: File) => Promise<void>
}

/**
 * UI plumbing for the Settings → Data group. Wraps `app.databaseTransfer`
 * with: a confirm dialog before destructive import, a player stop (symmetric
 * to `useDangerActions.onClearUserData`), and a user-visible error alert
 * when the underlying SQLite / share operation throws.
 */
export function useDataSettings(app: Shruti): UseDataSettingsReturn {
  const { t } = useI18n()
  const player = usePlayerStore()

  async function onExportDatabase(): Promise<void> {
    try {
      await app.databaseTransfer.exportDatabase()
    } catch (e) {
      await showError(t("settings.data.export.error"), e)
    }
  }

  async function onImportFileSelected(file: File): Promise<void> {
    const alert = await alertController.create({
      header: t("settings.data.import.confirm.header"),
      message: t("settings.data.import.confirm.message"),
      buttons: [
        { text: t("settings.data.import.confirm.cancel"), role: "cancel" },
        { text: t("settings.data.import.confirm.ok"), role: "destructive" },
      ],
    })
    await alert.present()
    const { role } = await alert.onDidDismiss()
    if (role !== "destructive") return

    // Mirror `useDangerActions.onClearUserData`: the audio engine could be
    // mid-playback on a track whose row is about to be wiped + replaced,
    // leaving the floating player pointing at a ghost. `stop()` is a no-op
    // when nothing is open, so it's safe unconditionally.
    if (player.open) await player.stop()

    try {
      // On success the adapter triggers `window.location.href = "/welcome"`,
      // so this promise never resolves — the page reloads instead. Any
      // throw before that lands here and surfaces an alert.
      await app.databaseTransfer.importDatabase(file)
    } catch (e) {
      await showError(t("settings.data.import.error"), e)
    }
  }

  async function showError(headerText: string, e: unknown): Promise<void> {
    const detail = e instanceof Error ? e.message : String(e)
    const alert = await alertController.create({
      header: headerText,
      message: detail,
      buttons: [{ text: t("settings.data.import.confirm.cancel"), role: "cancel" }],
    })
    await alert.present()
  }

  return { onExportDatabase, onImportFileSelected }
}
