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
  async openFirstTrack(): Promise<string> {
    const row = await this.firstVisible("ion-item.track")
    const title = (await (await row.$(".title")).getText()).trim()
    await row.click()
    return title
  }
}
