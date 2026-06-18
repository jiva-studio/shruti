import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// When in-app purchases aren't available and the user isn't subscribed, the
// Smart Library banner is hidden (the e2e default boot is non-Pro, and web has
// no IAP).
test(
  qase(48, "Smart Library banner is hidden when IAP is unavailable"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "search")

    // The landing has rendered (some banner is present)…
    await expect(page.locator(".library-banner").first()).toBeVisible({ timeout: 20_000 })
    // …but NOT the Smart Library banner.
    await expect(
      page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
    ).toHaveCount(0)
  }
)
