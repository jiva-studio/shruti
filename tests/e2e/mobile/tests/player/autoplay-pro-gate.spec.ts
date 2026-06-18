import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"

// Auto-play-next is Pro-gated: a free user tapping the Autoplay toggle opens the
// paywall instead of enabling it.
test(
  qase(59, "Auto-play next track is Pro-gated"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await toggle.click()

    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
  }
)
