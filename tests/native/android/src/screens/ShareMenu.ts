import { Screen } from "./Screen.js"

const ROW = (id: string) => `ion-action-sheet #${id}`

/** The per-track share menu: the app's own list of formats, above which the OS
 *  puts its chooser. */
export class ShareMenu extends Screen {
  async waitUntilVisible(timeoutMs = 30_000): Promise<void> {
    await this.open()
    await (await $("ion-action-sheet")).waitForDisplayed({ timeout: timeoutMs })
  }

  /** The only row that needs neither a transcript nor a downloaded audio file. */
  async shareLink(): Promise<void> {
    await this.pick("share-link")
  }

  /** The only format that hands the OS a file rather than a string. */
  async shareAudio(): Promise<void> {
    await this.pick("share-audio")
  }

  private async pick(id: string): Promise<void> {
    await this.waitUntilVisible()
    const row = await this.firstVisible(ROW(id))
    await row.click()
  }
}
