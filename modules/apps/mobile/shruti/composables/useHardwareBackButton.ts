import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { useBackButton, useIonRouter } from "@ionic/vue"

/**
 * Root-level hardware back. Ionic handles overlays (priority 100) and history
 * (priority 0) on its own; without a lower-priority handler the key is simply
 * swallowed on a root tab, while Android expects the app to minimize.
 */
export function useHardwareBackButton(): void {
  const router = useIonRouter()

  useBackButton(-1, () => {
    if (router.canGoBack()) return
    if (Capacitor.getPlatform() === "android") void App.minimizeApp()
  })
}
