import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// A subscriber tapping the Smart Library banner opens the Smart Library dialog
// (the offline build is treated as subscribed, so the banner opens the dialog —
// not the paywall).
test(
  qase(49, caseTitle(49)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true })
    await gotoTab(page, "search")

    // The Smart Library banner (distinguished by its background asset).
    const banner = page.locator(".library-banner", {
      has: page.locator('img[src*="smart-bg"]'),
    })

    await step(page, 49, 0, async () => {
      await banner.scrollIntoViewIfNeeded()
      await expect(banner).toBeVisible({ timeout: 20_000 })
    })

    await step(page, 49, 1, async () => {
      await banner.click()

      const dialog = page.locator("ion-modal.smart-library-dialog")
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      // The dialog exposes the Enable toggle.
      await expect(dialog.locator("ion-toggle").first()).toBeVisible({ timeout: 10_000 })
    })
  }
)
