import { computed, reactive } from "vue"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { Capacitor } from "@capacitor/core"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { PurchaseCancelledError, type PurchasePackage } from "@ports/app/purchases.js"

export interface LegalDocument {
  title: string
  link: string
}

/**
 * Plain (auto-unwrapped) view over the purchases store, suitable for
 * passing into UI components. `reactive` unwraps the nested refs so
 * `binding.available` in a template is `boolean`, not `Ref<boolean>`.
 */
export interface SubscriptionBinding {
  readonly available: boolean
  readonly isSubscribed: boolean
  readonly packages: PurchasePackage[]
  readonly purchasing: boolean
  readonly restoring: boolean
  readonly legalDocuments: LegalDocument[]
  onSubscribe: (packageId: string) => Promise<void>
  onRestore: () => Promise<void>
  onManage: () => void
}

/**
 * Wires the purchases store into the Settings view. The store is the
 * single source of truth — no entitlement state is ever persisted by
 * the app itself. Post-action UX (the thanks alert, restore-not-found
 * alert) lives here rather than inside the UI components so the
 * `ui/features/settings/*` files stay framework-pure.
 */
export function useSubscriptionBinding(): SubscriptionBinding {
  const { t } = useI18n()
  const store = usePurchasesStore()

  const legalDocuments = computed<LegalDocument[]>(() => {
    const docs: LegalDocument[] = [
      { title: t("settings.subscription.legal.privacy"), link: "https://shruti.app/policy" },
    ]
    // Apple requires a "Terms of Use" link in any UI that sells a
    // subscription; we point to Apple's standard EULA when the app
    // has no product-specific terms page.
    if (Capacitor.getPlatform() === "ios") {
      docs.push({
        title: t("settings.subscription.legal.terms"),
        link: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/",
      })
    }
    return docs
  })

  async function onSubscribe(packageId: string): Promise<void> {
    try {
      await store.purchase(packageId)
    } catch (e) {
      if (e instanceof PurchaseCancelledError) return
      await showError(e)
      return
    }
    if (store.isSubscribed) {
      const alert = await alertController.create({
        header: t("settings.subscription.subscribed"),
        message: t("settings.subscription.thanks"),
        buttons: [t("app.ok")],
      })
      await alert.present()
    }
  }

  async function onRestore(): Promise<void> {
    try {
      await store.restore()
    } catch (e) {
      await showError(e)
      return
    }
    const alert = await alertController.create({
      header: t("settings.subscription.title"),
      message: store.isSubscribed
        ? t("settings.subscription.restored")
        : t("settings.subscription.noSubscriptionFound"),
      buttons: [t("app.ok")],
    })
    await alert.present()
  }

  function onManage(): void {
    const url = store.managementUrl
    if (!url) return
    // Capacitor's webview opens external schemes in the system browser /
    // Play/App Store app — no Browser plugin needed.
    window.open(url, "_blank")
  }

  async function showError(e: unknown): Promise<void> {
    const err = e as { message?: string; underlyingErrorMessage?: string }
    console.error("subscription error", e)
    const alert = await alertController.create({
      header: t("settings.subscription.title"),
      message: [t("settings.subscription.error"), err?.message, err?.underlyingErrorMessage]
        .filter(Boolean)
        .join(" "),
      buttons: [t("app.ok")],
    })
    await alert.present()
  }

  return reactive({
    available: computed(() => store.available),
    isSubscribed: computed(() => store.isSubscribed),
    packages: computed(() => store.packages),
    purchasing: computed(() => store.purchasing),
    restoring: computed(() => store.restoring),
    legalDocuments,
    onSubscribe,
    onRestore,
    onManage,
  }) as SubscriptionBinding
}
