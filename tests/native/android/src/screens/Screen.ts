import type { WebView } from "../adapters/android/WebView.js"

export abstract class Screen {
  constructor(protected readonly webView: WebView) {}

  protected async open(): Promise<void> {
    await this.webView.enter()
  }

  /** Every element matching `selector` that is actually on screen. */
  protected async visibleRows(selector: string, timeoutMs = 60_000) {
    await this.open()
    return browser.waitUntil(
      async () => {
        const candidates = await $$(selector)
        const shown = []
        for (const candidate of candidates) if (await candidate.isDisplayed()) shown.push(candidate)
        return shown.length ? shown : false
      },
      { timeout: timeoutMs, interval: 2_000, timeoutMsg: `no visible "${selector}"` },
    )
  }

  /** First element matching `selector` that is actually on screen — a tab keeps its offscreen rows in the DOM. */
  protected async firstVisible(selector: string, timeoutMs = 60_000) {
    await this.open()
    const found = await browser.waitUntil(
      async () => {
        const candidates = await $$(selector)
        for (const candidate of candidates) if (await candidate.isDisplayed()) return candidate
        return false
      },
      { timeout: timeoutMs, interval: 2_000, timeoutMsg: `no visible "${selector}"` },
    )
    return found
  }
}
