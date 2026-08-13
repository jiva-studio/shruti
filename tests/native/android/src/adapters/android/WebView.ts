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
}
