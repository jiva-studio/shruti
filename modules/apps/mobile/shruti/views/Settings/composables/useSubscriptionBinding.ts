import { computed, reactive } from "vue"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
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
  /** Temporary on-screen diagnostic trail — remove once IAP is trusted. */
  readonly debugLog: string[]
  /** RC-side customer id; surfaced in the debug build-info footer. */
  readonly appUserId: string | undefined
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
  const i18n = useI18n()
  const { t } = i18n
  const store = usePurchasesStore()
  const platform = useShruti().platform

  const legalDocuments = computed<LegalDocument[]>(() => {
    // Privacy policy is served from this repo's GitHub Pages
    // (.github/workflows/pages.yml uploads modules/web/policy/ as the
    // site root). EN is index.html, RU is ru.html — link to the locale
    // the user is currently in.
    const policyBase = "https://jiva-studio.github.io/shruti"
    const policyUrl =
      (i18n.locale.value as string) === "ru" ? `${policyBase}/ru.html` : `${policyBase}/`
    const docs: LegalDocument[] = [
      { title: t("settings.subscription.legal.privacy"), link: policyUrl },
    ]
    // Apple requires a "Terms of Use" link in any UI that sells a
    // subscription; we point to Apple's standard EULA when the app
    // has no product-specific terms page.
    if (platform === "ios") {
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
    debugLog: computed(() => store.debugLog),
    appUserId: computed(() => store.appUserId),
    legalDocuments,
    onSubscribe,
    onRestore,
    onManage,
  }) as SubscriptionBinding
}
