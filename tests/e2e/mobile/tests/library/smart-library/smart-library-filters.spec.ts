import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Inside the Smart Library dialog, with the feature enabled, the "Filter" row
// opens the search-filters sheet (so the user can scope what auto-downloads).
test(
  qase(51, caseTitle(51)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true })
    await gotoTab(page, "search")

    const banner = page.locator(".library-banner", {
      has: page.locator('img[src*="smart-bg"]'),
    })

    const dialog = page.locator("ion-modal.smart-library-dialog")

    await step(page, 51, 0, async () => {
      await banner.scrollIntoViewIfNeeded()
      await banner.click()

      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Enable so the filter row is interactive.
      const enable = dialog.locator("ion-toggle").first()
      if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
    })

    await step(page, 51, 1, async () => {
      // The "Filter" row opens the filters sheet.
      await dialog.locator("ion-item", { hasText: "Filter" }).first().click()
      await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({ timeout: 10_000 })
    })
  }
)
