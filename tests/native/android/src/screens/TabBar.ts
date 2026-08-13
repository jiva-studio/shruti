import { Screen } from "./Screen.js"

export type Tab = "home" | "search" | "chat" | "notes" | "settings"

export class TabBar extends Screen {
  async waitUntilVisible(timeoutMs = 90_000): Promise<void> {
    await this.open()
    await (await $("ion-tab-bar")).waitForDisplayed({ timeout: timeoutMs })
  }

  async go(tab: Tab): Promise<void> {
    await this.open()
    await (await $(`#tab-button-${tab}`)).click()
  }
}
