import { Screen } from "./Screen.js"

export class SettingsScreen extends Screen {
  private async toggleFor(label: string) {
    const items = await this.visibleRows("ion-item")
    for (const item of items) {
      const text = (await item.getText()).toLowerCase()
      if (!text.includes(label.toLowerCase())) continue
      const toggle = await item.$("ion-toggle")
      if (await toggle.isExisting()) return toggle
    }
    throw new Error(`no toggle next to "${label}" on the settings screen`)
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
