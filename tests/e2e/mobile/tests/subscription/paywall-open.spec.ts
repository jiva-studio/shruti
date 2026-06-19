import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// A free user tapping a Pro-gated entry point opens the paywall (the
// subscription screen). The e2e build boots NON-Pro by default, so the
// Autoplay (Pro) toggle is a working entry point.
test(
  qase(101, caseTitle(101)),
  { tag: ["@offline", "@subscription"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "settings")

    await step(page, 101, 0, async () => {
      const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).toBeVisible({ timeout: 10_000 })
      await toggle.click()

      // The subscription / paywall screen opens.
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })
  }
)
