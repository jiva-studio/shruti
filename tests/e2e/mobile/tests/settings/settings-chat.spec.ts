import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The chat settings group exposes the "Translate quotes" toggle; flipping it
// persists across a restart. (The actual answer-language generation is a live
// backend concern, not asserted offline.)
test(
  qase(119, caseTitle(119)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "settings")

    let after = ""
    await step(page, 119, 0, async () => {
      const toggle = page.locator("ion-item", { hasText: "Translate quotes" }).locator("ion-toggle")
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).toBeVisible({ timeout: 10_000 })

      const before = await toggle.getAttribute("aria-checked")
      after = before === "true" ? "false" : "true"
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-checked", after)
    })

    await step(page, 119, 1, async () => {
      // Persists across a reload (config is stored in preferences/localStorage).
      await page.reload()
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await gotoTab(page, "settings")
      const toggle2 = page.locator("ion-item", { hasText: "Translate quotes" }).locator("ion-toggle")
      await toggle2.scrollIntoViewIfNeeded()
      await expect(toggle2).toHaveAttribute("aria-checked", after, { timeout: 10_000 })
    })
  }
)
