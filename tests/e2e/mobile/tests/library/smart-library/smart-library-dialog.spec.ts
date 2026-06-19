import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Smart Library dialog (Pro) in one case: a subscriber taps the banner to open
// the dialog, flips the Enable toggle on and back off, and opens the Filter row
// → the search-filters sheet. The offline build is treated as subscribed
// (pro:true), so the banner opens the dialog (not the paywall).
test(
  qase(49, caseTitle(49)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true, userDb: "clean" })
    await gotoTab(page, "search")

    const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
    const dialog = page.locator("ion-modal.smart-library-dialog")
    const enable = dialog.locator("ion-toggle").first()

    await step(page, 49, 0, async () => {
      // Tap the Smart Library banner → the dialog opens with the Enable toggle.
      await banner.scrollIntoViewIfNeeded()
      await expect(banner).toBeVisible({ timeout: 20_000 })
      await banner.click()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await expect(enable).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 49, 1, async () => {
      // The Enable toggle flips on and back off.
      const before = await enable.getAttribute("aria-checked")
      const after = before === "true" ? "false" : "true"
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", after)
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", before ?? "false")
    })

    await step(page, 49, 2, async () => {
      // With the feature enabled, the Filter row opens the search-filters sheet.
      if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
      await dialog.locator("ion-item", { hasText: "Filter" }).first().click()
      await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({ timeout: 10_000 })
    })
  }
)
