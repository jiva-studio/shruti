import { Screen } from "./Screen.js"

const EMPTY_CELL = "var(--heatmap-empty)"
/** The streak badge is the only accent-painted one in the activity header. */
const ACCENT = "--ion-color-primary"

export class ActivityCard extends Screen {
  async isVisible(): Promise<boolean> {
    await this.open()
    const card = await $(".activity-card")
    return (await card.isExisting()) && (await card.isDisplayed())
  }

  async streak(): Promise<number> {
    await this.open()
    const badges = await $$(".activity-stat-badge")
    for (const badge of badges) {
      if (!(await badge.isDisplayed())) continue
      if (!((await badge.getAttribute("style")) ?? "").includes(ACCENT)) continue
      return Number((await badge.getText()).trim())
    }
    // At zero the badge is not rendered at all.
    return 0
  }

  /** Whether the cell for the device's current day is painted as listened. */
  async todayHasListening(): Promise<boolean> {
    await this.open()
    return (await (await this.todayCell()).getAttribute("fill")) !== EMPTY_CELL
  }

  /** Today is the one cell the grid outlines. */
  private async todayCell() {
    const cells = await $$(".activity-card .kit-heatmap rect")
    for (const cell of cells) if ((await cell.getAttribute("stroke")) !== "none") return cell
    throw new Error("the heatmap rendered no today cell")
  }
}
