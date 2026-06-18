import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"

// Notes are stored in the user DB and survive an app restart: the seeded notes
// are still listed after a reload.
test(
  qase(10, "Notes persist across app restart"),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "notes")

    const notes = page.locator("ion-item.note")
    await expect(notes.first()).toBeVisible({ timeout: 15_000 })
    const before = await notes.count()
    expect(before).toBeGreaterThan(0)

    // "Restart" the app.
    await page.reload()
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    await gotoTab(page, "notes")

    await expect.poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 }).toBe(before)
  }
)
