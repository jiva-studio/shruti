export interface ViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The Capacitor bridge publishes its context a beat after MainActivity resumes. */
export class WebView {
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
