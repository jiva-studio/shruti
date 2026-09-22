/**
 * Port over the native share sheet (`@capacitor/share` on mobile,
 * Web Share API on the browser when available) and the platform
 * clipboard. Keeps platform-specific sharing concerns out of views.
 */
export interface ShareOptions {
  title?: string
  text?: string
  url?: string
  dialogTitle?: string
}

export interface IShareService {
  /** Opens the platform share sheet. Resolves when the user declines it or the
   *  platform has none; rejects when the share itself failed. */
  share(options: ShareOptions): Promise<void>
  /** True when the platform exposes a share sheet. */
  canShare(): Promise<boolean>
  /** Writes `text` to the platform clipboard. Resolves on failure. */
  copyToClipboard(text: string): Promise<void>
}
