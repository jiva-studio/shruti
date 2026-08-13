import { Screen } from "./Screen.js"

export class AppTheme extends Screen {
  async prefersDark(): Promise<boolean> {
    await this.open()
    return browser.execute(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  }

  async bodyBackground(): Promise<string> {
    await this.open()
    return browser.execute(() => getComputedStyle(document.body).backgroundColor)
  }
}
