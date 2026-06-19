import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Inside the Smart Library dialog the Enable toggle flips on and off and the
// summary follows it. (The background auto-download loop itself is not asserted
// offline — see case 52.)
test(
  qase(50, caseTitle(50)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true })
    await gotoTab(page, "search")

    const banner = page.locator(".library-banner", {
      has: page.locator('img[src*="smart-bg"]'),
    })

    const enable = page.locator("ion-modal.smart-library-dialog ion-toggle").first()
    let before: string | null = null
    let after = "true"

    await step(page, 50, 0, async () => {
      await banner.scrollIntoViewIfNeeded()
      await banner.click()

      const dialog = page.locator("ion-modal.smart-library-dialog")
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      await expect(enable).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 50, 1, async () => {
      before = await enable.getAttribute("aria-checked")
      after = before === "true" ? "false" : "true"
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", after)
    })

    await step(page, 50, 2, async () => {
      // Flip it back.
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", before ?? "false")
    })
  }
)
