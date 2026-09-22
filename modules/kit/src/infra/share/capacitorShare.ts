import { Share } from "@capacitor/share"
import type { IShareService, ShareOptions } from "./share.js"

/**
 * {@link IShareService} backed by `@capacitor/share`. The plugin handles
 * both native share sheets and the Web Share API transparently. Clipboard
 * falls through to `navigator.clipboard`, which is the only mechanism
 * available both in the Capacitor WebView and the desktop browser.
 */

/** Both native platforms reject a dismissed sheet with this exact message. */
const CANCELLED = /Share canceled/i

function isDeclined(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  const message = error instanceof Error ? error.message : String(error)
  return CANCELLED.test(message) || /unavailable|not available/i.test(message)
}

export function useCapacitorShareService(): IShareService {
  return {
    async share(options: ShareOptions): Promise<void> {
      try {
        await Share.share(options)
      } catch (error) {
        // Anything else is a share that did not happen — a file the OS
        // refused to grant access to reaches the user as nothing at all.
        if (!isDeclined(error)) throw error
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
