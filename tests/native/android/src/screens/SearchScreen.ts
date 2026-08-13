import { Screen } from "./Screen.js"

export class SearchScreen extends Screen {
  async firstTrackTitle(): Promise<string> {
    const row = await this.firstVisible("ion-item.track")
    return (await (await row.$(".title")).getText()).trim()
  }

  async focusSearchField(): Promise<void> {
    await this.open()
    const field = await $(".search-row textarea")
    await field.waitForDisplayed({ timeout: 30_000 })
    await field.click()
  }

  /** Tapping a row opens the track sheet; it does not start playback. */
  async openTrackAt(index = 0): Promise<string> {
    const rows = await this.visibleRows("ion-item.track")
    const row = rows[index]
    if (!row) throw new Error(`only ${rows.length} track rows on screen, wanted #${index}`)
    const title = (await (await row.$(".title")).getText()).trim()
    await row.click()
    return title
  }

  async openFirstTrack(): Promise<string> {
    const row = await this.firstVisible("ion-item.track")
    const title = (await (await row.$(".title")).getText()).trim()
    await row.click()
    return title
  }
}
