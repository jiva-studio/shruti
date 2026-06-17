import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows } from "../support/nav.js"

test(
  "library · opening a collection shows its lectures",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "search")

    // Tap the first collection card in a discovery carousel.
    const card = page.locator(".carousel-section .collection-card").first()
    await card.waitFor({ state: "visible", timeout: 20_000 })
    await card.click()

    await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
    await page.waitForTimeout(500) // settle the page transition before reading rows
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
  }
)
