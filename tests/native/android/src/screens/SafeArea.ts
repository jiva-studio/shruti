import { Screen } from "./Screen.js"

export interface Insets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

/** The safe area as the WebView itself resolves it — every layout in the app is
 *  built on `env(safe-area-inset-*)` (Ionic re-exports it as `--ion-safe-area-*`). */
export class SafeArea extends Screen {
  /** `env(safe-area-inset-*)`, in CSS pixels. */
  async insets(): Promise<Insets> {
    await this.open()
    return browser.execute(() => {
      const probe = document.createElement("div")
      probe.style.cssText = [
        "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden",
        "padding-top:env(safe-area-inset-top)",
        "padding-right:env(safe-area-inset-right)",
        "padding-bottom:env(safe-area-inset-bottom)",
        "padding-left:env(safe-area-inset-left)",
      ].join(";")
      document.body.appendChild(probe)
      const style = getComputedStyle(probe)
      const px = (value: string): number => Number.parseFloat(value) || 0
      const insets = {
        top: px(style.paddingTop),
        right: px(style.paddingRight),
        bottom: px(style.paddingBottom),
        left: px(style.paddingLeft),
      }
      probe.remove()
      return insets
    })
  }

  /** Where the page's content box starts, in CSS pixels. `AppPage` pads every
   *  screen down by the top inset, so this is the first pixel the user's own
   *  content may occupy. */
  async contentTop(): Promise<number> {
    const content = await this.firstVisible(".page-content")
    return browser.execute((el: HTMLElement) => el.getBoundingClientRect().top, content)
  }

  /** The page's own top edge on the display, in device pixels. The bridge
   *  insets the whole view when Chromium is too old to resolve `env()`, and
   *  that offset is invisible from inside the page. */
  async viewportTopDevicePx(): Promise<number> {
    return (await this.webView.bounds()).y
  }

  /** Where the first pixel of the user's content lands on the display, in
   *  device pixels — the view's own offset included. */
  async contentTopDevicePx(): Promise<number> {
    const top = await this.contentTop()
    const ratio = await browser.execute(() => window.devicePixelRatio)
    return (await this.viewportTopDevicePx()) + top * ratio
  }
}
