import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Notes are stored in the user DB and survive an app restart: the seeded notes
// are still listed after a reload.
test(
  qase(10, caseTitle(10)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    let before = 0

    await step(page, 10, 0, async () => {
      await gotoTab(page, "notes")

      const notes = page.locator("ion-item.note")
      await expect(notes.first()).toBeVisible({ timeout: 15_000 })
      before = await notes.count()
      expect(before).toBeGreaterThan(0)
    })

    await step(page, 10, 1, async () => {
      // "Restart" the app.
      await page.reload()
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await gotoTab(page, "notes")

      await expect.poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 }).toBe(before)
    })
  }
)
