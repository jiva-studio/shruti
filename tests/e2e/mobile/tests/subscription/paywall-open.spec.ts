import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"

// A free user tapping a Pro-gated entry point opens the paywall (the
// subscription screen). The e2e build boots NON-Pro by default, so the
// Autoplay (Pro) toggle is a working entry point.
test(
  qase(101, "Paywall opens from its entry points"),
  { tag: ["@offline", "@subscription"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()

    // The subscription / paywall screen opens.
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
  }
)
