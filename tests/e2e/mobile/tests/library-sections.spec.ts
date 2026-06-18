import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// The Search (library) landing surfaces its sections fully formed: collection-
// group carousels, the topics tile grid, the Full Library banner with a count,
// and the all-lectures preview. (The Smart Library banner is IAP-gated and not
// asserted here.)
test(
  qase(34, "Library landing shows its sections"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "search")

    // Collection-group carousels.
    await expect(page.locator(".carousel-section").first()).toBeVisible({ timeout: 20_000 })
    // Topics tile grid.
    await expect(page.locator(".tile-grid").first()).toBeVisible({ timeout: 20_000 })
    // Full Library banner (with the lecture count).
    await expect(page.locator(".library-banner").first()).toBeVisible({ timeout: 20_000 })
    // All-lectures preview.
    await expect(page.locator(".all-lectures")).toBeVisible({ timeout: 20_000 })
  }
)
