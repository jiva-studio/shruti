import { alertController } from "@ionic/vue"
import { ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { resetLocalUserDatabaseFromApp } from "@shruti/services/dataWipe.js"

export interface UseStorageErrorActionsReturn {
  /** True while the reset runs, so the buttons can be disabled. */
  readonly busy: Ref<boolean>
  /** Re-run bootstrap. The whole recovery for a transient failure. */
  onRetry: () => void
  /** Confirm, then delete the user database and re-bootstrap. */
  onReset: () => Promise<void>
}

/**
 * The two ways off `/storage-error`.
 *
 * Retry alone used to be the only one, and it re-runs the bootstrap that just
 * failed — fine for a device that was out of space, useless for a `user.db`
 * that is corrupt or hits a deterministic migration bug. Settings is behind the
 * router guard, so wipe/import/export were unreachable, and reinstalling — at
 * the cost of the ~54 MB catalog as well — was the only exit (#1831).
 */
export function useStorageErrorActions(): UseStorageErrorActionsReturn {
  const { t } = useI18n()
  const busy = ref(false)

  function onRetry(): void {
    // A full reload, not a router push: opening a database is bootstrap's job
    // and bootstrap runs once, before mount.
    window.location.href = "/"
  }

  async function onReset(): Promise<void> {
    if (busy.value) return

    const confirm = await alertController.create({
      header: t("errors.storage.reset.confirm.header"),
      message: t("errors.storage.reset.confirm.message"),
      buttons: [
        { text: t("errors.storage.reset.confirm.cancel"), role: "cancel" },
        { text: t("errors.storage.reset.confirm.ok"), role: "destructive" },
      ],
    })
    await confirm.present()
    const { role } = await confirm.onDidDismiss()
    if (role !== "destructive") return

    busy.value = true
    try {
      await resetLocalUserDatabaseFromApp(useShruti())
    } catch (err) {
      busy.value = false
      const detail = err instanceof Error ? err.message : String(err)
      const failed = await alertController.create({
        header: t("errors.storage.reset.error"),
        message: detail,
        buttons: [{ text: t("errors.storage.reset.confirm.cancel"), role: "cancel" }],
      })
      await failed.present()
      return
    }
    // Same hard reload as the retry: the next bootstrap creates an empty user
    // database and migrates it from zero.
    window.location.href = "/"
  }

  return { busy, onRetry, onReset }
}
