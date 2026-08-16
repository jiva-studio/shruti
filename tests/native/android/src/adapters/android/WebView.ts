export interface ViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The Capacitor bridge publishes its context a beat after MainActivity resumes. */
export class WebView {
  private page?: string

  constructor(private readonly appPackage: string) {}

  private get name(): string {
    return `WEBVIEW_${this.appPackage}`
  }

  async contexts(timeoutMs = 60_000): Promise<string[]> {
    let seen: string[] = []
    await browser.waitUntil(
      async () => {
        seen = (await browser.getContexts()) as string[]
        return seen.includes(this.name)
      },
      { timeout: timeoutMs, interval: 1_000, timeoutMsg: "no WebView context appeared" },
    )
    return seen
  }

  async enter(): Promise<void> {
    await this.contexts()
    if ((await browser.getContext()) !== this.name) await browser.switchContext(this.name)
    await this.attachToLivePage()
  }

  /**
   * A relaunched app puts up a new page, but the session stays pinned to the
   * destroyed one. Appium re-attaches by itself only when its staleness probe
   * (`GET /url`) fails, and a destroyed page answers it with `null` instead —
   * the window is only reported gone once a real command is sent.
   */
  private async attachToLivePage(): Promise<void> {
    await browser.waitUntil(
      async () => {
        const pages = await browser.getWindowHandles()
        if (this.page && pages.includes(this.page)) return true
        if (!pages[0]) return false
        await browser.switchToWindow(pages[0])
        this.page = pages[0]
        return true
      },
      { timeout: 60_000, interval: 1_000, timeoutMsg: "the WebView published no live page" },
    )
  }

  async leave(): Promise<void> {
    await browser.switchContext("NATIVE_APP")
  }

  /**
   * Where the view sits on the display, in device pixels. Read natively and
   * from outside the page: the bridge may keep the page off a display cutout
   * by insetting this view, which nothing inside the page can see.
   */
  async bounds(): Promise<ViewBounds> {
    await this.leave()
    const view = await $("android.webkit.WebView")
    const { x, y } = await view.getLocation()
    const { width, height } = await view.getSize()
    return { x, y, width, height }
  }
}
