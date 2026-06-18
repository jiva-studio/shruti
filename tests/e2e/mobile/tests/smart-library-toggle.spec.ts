import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// Inside the Smart Library dialog the Enable toggle flips on and off and the
// summary follows it. (The background auto-download loop itself is not asserted
// offline — see case 52.)
test(
  qase(50, "Enable and disable Smart Library"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true })
    await gotoTab(page, "search")

    const banner = page.locator(".library-banner", {
      has: page.locator('img[src*="smart-bg"]'),
    })
    await banner.scrollIntoViewIfNeeded()
    await banner.click()

    const dialog = page.locator("ion-modal.smart-library-dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    const enable = dialog.locator("ion-toggle").first()
    await expect(enable).toBeVisible({ timeout: 10_000 })
    const before = await enable.getAttribute("aria-checked")
    const after = before === "true" ? "false" : "true"
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", after)

    // Flip it back.
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", before ?? "false")
  }
)
