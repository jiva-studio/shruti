import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// For a free user a Pro appearance toggle (Autoplay) does NOT turn on — it opens
// the paywall instead and stays off.
test(
  qase(118, caseTitle(118)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    await step(page, 118, 0, async () => {
      const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).toHaveAttribute("aria-checked", "false")

      await toggle.click()
      // The paywall opens.
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 118, 1, async () => {
      // Going back, the toggle is still off (it never enabled).
      await page.goBack()
      await gotoTab(page, "settings")
      const toggle2 = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle2.scrollIntoViewIfNeeded()
      await expect(toggle2).toHaveAttribute("aria-checked", "false", { timeout: 10_000 })
    })
  }
)
