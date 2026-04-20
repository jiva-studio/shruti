import { Share } from "@capacitor/share"
import type { IShareService, ShareOptions } from "@ports/app/index.js"

/**
 * `IShareService` backed by `@capacitor/share`. The plugin handles
 * both native share sheets and the Web Share API transparently. On
 * platforms without either, `share()` rejects — we swallow the error
 * so callers can treat the call as fire-and-forget. Clipboard falls
 * through to `navigator.clipboard`, which is the only mechanism
 * available both in the Capacitor WebView and the desktop browser.
 */
export function useCapacitorShareService(): IShareService {
  return {
    async share(options: ShareOptions): Promise<void> {
      try {
        await Share.share(options)
      } catch {
        // User cancelled or platform has no share sheet — non-fatal.
      }
    },

    async canShare(): Promise<boolean> {
      try {
        const result = await Share.canShare()
        return result.value
      } catch {
        return false
      }
    },

    async copyToClipboard(text: string): Promise<void> {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          await navigator.clipboard.writeText(text)
        }
      } catch {
        // Non-fatal: insecure origin, permission denied, etc.
      }
    },
  }
}
