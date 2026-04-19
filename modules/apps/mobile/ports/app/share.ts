/**
 * Port over the native share sheet (@capacitor/share on mobile,
 * Web Share API on the browser when available).
 */
export interface ShareOptions {
  title?: string
  text?: string
  url?: string
  dialogTitle?: string
}

export interface IShareService {
  share(options: ShareOptions): Promise<void>
  canShare(): Promise<boolean>
}
