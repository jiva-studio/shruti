import type { WebView } from "../adapters/android/WebView.js"

export abstract class Screen {
  constructor(protected readonly webView: WebView) {}

  protected async open(): Promise<void> {
    await this.webView.enter()
  }

  /** First element matching `selector` that is actually on screen — a tab keeps its offscreen rows in the DOM. */
  protected async firstVisible(selector: string, timeoutMs = 60_000) {
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
