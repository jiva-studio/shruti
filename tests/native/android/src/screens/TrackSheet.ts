import { Screen } from "./Screen.js"

export class TrackSheet extends Screen {
  private get modal() {
    return $("ion-modal.track-sheet")
  }

  /** The sheet's primary action queues the track and starts its download. */
  async addToQueue(): Promise<void> {
    await this.open()
    const add = await $("ion-modal.track-sheet .add-btn")
    await add.waitForDisplayed({ timeout: 30_000 })
    await add.click()
    await this.dismiss()
  }

  /** Opens the share menu; the sheet stays open behind it. */
  async share(): Promise<void> {
    await this.open()
    const share = await $("ion-modal.track-sheet .share-btn")
    await share.waitForDisplayed({ timeout: 30_000 })
    await share.click()
  }

  /** Reads the page, so it enters the WebView first: asked from the native
   *  context the selector matches nothing and every sheet looks closed. */
  async isClosed(): Promise<boolean> {
    await this.open()
    const modal = await this.modal
    return !(await modal.isExisting()) || !(await modal.isDisplayed())
  }

  async dismiss(): Promise<void> {
    try {
      await browser.waitUntil(() => this.isClosed(), { timeout: 15_000, interval: 1_000 })
      return
    } catch {
      const close = await $("ion-modal.track-sheet .close-button")
      if (await close.isExisting()) await close.click()
    }
    await browser.waitUntil(() => this.isClosed(), {
      timeout: 15_000,
      interval: 1_000,
      timeoutMsg: "the track sheet would not close",
    })
  }
}
