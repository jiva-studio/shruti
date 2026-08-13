import { Screen } from "./Screen.js"

/** The per-track share menu: the app's own list of formats, above which the OS
 *  puts its chooser. */
export class ShareMenu extends Screen {
  async waitUntilVisible(timeoutMs = 30_000): Promise<void> {
    await this.open()
    await (await $("ion-action-sheet")).waitForDisplayed({ timeout: timeoutMs })
  }

  /** The link is the first row and the only one that needs neither a
   *  transcript nor a downloaded audio file. */
  async shareLink(): Promise<void> {
    await this.waitUntilVisible()
    const row = await this.firstVisible(
      "ion-action-sheet .action-sheet-button:not(.action-sheet-cancel)",
    )
    await row.click()
  }
}
