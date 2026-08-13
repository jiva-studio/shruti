import { Screen } from "./Screen.js"

export class PlayerBar extends Screen {
  async isVisible(): Promise<boolean> {
    await this.open()
    const player = await $(".player")
    if (!(await player.isExisting())) return false
    return !((await player.getAttribute("class")) ?? "").includes("hidden")
  }

  async waitUntilVisible(timeoutMs = 60_000): Promise<void> {
    await this.open()
    await browser.waitUntil(() => this.isVisible(), {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: "the player stayed hidden",
    })
  }
}
