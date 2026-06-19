import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Pro expiry re-locks Pro features: enable a Pro toggle while subscribed, then
// "expire" Pro (the e2e force-free flag) across a restart — the toggle is gated
// again and tapping it opens the paywall.
test(
  qase(111, caseTitle(111)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true })

    await step(page, 111, 0, async () => {
      await gotoTab(page, "settings")

      const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle.scrollIntoViewIfNeeded()
      // As Pro, the toggle enables (no paywall).
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-checked", "true")
    })

    await step(page, 111, 1, async () => {
      // Expire Pro and restart.
      await page.evaluate(() => localStorage.setItem("CapacitorStorage.e2e.forceFreeTier", "1"))
      await page.reload()
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await gotoTab(page, "settings")

      const toggle2 = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle2.scrollIntoViewIfNeeded()
      // Now Pro-expired: it's gated again → tapping opens the paywall.
      await toggle2.click()
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })
  }
)
