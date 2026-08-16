import { Screen } from "./Screen.js"

export class SettingsScreen extends Screen {
  /**
   * Matching runs over *visible* rows on purpose: Ionic keeps every visited tab
   * mounted, so an unscoped `ion-item` search would return rows from Home or
   * Library just as happily. The cost is that a setting below the fold is
   * invisible here, so page the list down until it shows up — a row added above
   * one of these toggles must not break the specs that use it.
   */
  private async toggleFor(label: string) {
    for (let page = 0; page <= 10; page++) {
      const items = await this.visibleRows("ion-item")
      for (const item of items) {
        const text = (await item.getText()).toLowerCase()
        if (!text.includes(label.toLowerCase())) continue
        const toggle = await item.$("ion-toggle")
        if (await toggle.isExisting()) return toggle
      }
      if (!(await this.pageDown())) break
    }
    throw new Error(`no toggle next to "${label}" on the settings screen`)
  }

  /**
   * One screenful down the settings list, false once it will not move further.
   *
   * Through `ion-content`'s own scroller: it is a custom element holding its own
   * scroll container, so `scrollIntoView` on a row moves nothing.
   */
  private async pageDown(): Promise<boolean> {
    return browser.execute(function () {
      const shown = Array.from(document.querySelectorAll("ion-content")).find(
        (c) => (c as HTMLElement).offsetParent !== null,
      ) as (HTMLElement & { getScrollElement?: () => Promise<HTMLElement> }) | undefined
      if (!shown?.getScrollElement) return Promise.resolve(false)
      return shown.getScrollElement().then((scroller) => {
        const before = scroller.scrollTop
        scroller.scrollTop = before + scroller.clientHeight * 0.8
        return scroller.scrollTop > before
      })
    })
  }

  async isEnabled(label: string): Promise<boolean> {
    await this.open()
    return (await (await this.toggleFor(label)).getAttribute("aria-checked")) === "true"
  }

  async enable(label: string): Promise<void> {
    await this.open()
    if (await this.isEnabled(label)) return
    const toggle = await this.toggleFor(label)
    await toggle.scrollIntoView({ block: "center" })
    await toggle.click()
    await browser.waitUntil(() => this.isEnabled(label), {
      timeout: 15_000,
      interval: 1_000,
      timeoutMsg: `"${label}" did not switch on`,
    })
  }
}
