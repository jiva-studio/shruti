import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Auto-play-next is Pro-gated: a free user tapping the Autoplay toggle opens the
// paywall instead of enabling it.
test(
  qase(59, caseTitle(59)),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
    await step(page, 59, 0, async () => {
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).toHaveAttribute("aria-checked", "false")
    })
    await step(page, 59, 1, async () => {
      await toggle.click()
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })
  }
)
