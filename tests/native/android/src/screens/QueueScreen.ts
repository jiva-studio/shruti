import { Screen } from "./Screen.js"

export class QueueScreen extends Screen {
  async playFirst(): Promise<void> {
    const row = await this.firstVisible(".playlist-row")
    await (await row.$("ion-item.track")).click()
  }

  async removeFirst(): Promise<void> {
    const row = await this.firstVisible(".playlist-row")
    const sliding = await row.$("ion-item-sliding")
    // Ionic reveals the options through the component's own API; a synthetic
    // swipe in a WebView does not move it.
    if (await sliding.isExisting()) {
      await browser.execute((el: HTMLElement) => {
        ;(el as HTMLElement & { open?: (side: string) => Promise<void> }).open?.("end")
      }, sliding)
    }
    const remove = await row.$('ion-item-option[color="danger"]')
    await remove.waitForDisplayed({ timeout: 15_000 })
    await remove.click()
  }

  async isEmpty(): Promise<boolean> {
    const rows = await $$(".playlist-row")
    for (const row of rows) if (await row.isDisplayed()) return false
    return true
  }
}
