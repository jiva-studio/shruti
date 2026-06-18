import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab, playlistRows } from "../support/nav.js"

// "Add all" on a collection confirms, then adds every (language-filtered) track
// to the playlist in one batch. We assert the confirm dialog and that the queue
// grows (exact count is the language-filtered collection size).
test(
  qase(40, "Add the whole collection at once"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    const before = await playlistRows(page).count()

    await gotoTab(page, "search")
    const card = page.locator(".carousel-section .collection-card").first()
    await card.waitFor({ state: "visible", timeout: 20_000 })
    await card.click()
    await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
    await page.waitForTimeout(800)

    // Toolbar "Add collection" (add-all).
    await page.locator('[aria-label="Add collection"]').click()

    // Confirm the "Add N lectures?" alert.
    const alert = page.locator("ion-alert")
    await expect(alert).toBeVisible({ timeout: 10_000 })
    await alert.locator("button", { hasText: /^Ok$/ }).click()

    await gotoTab(page, "home")
    await expect
      .poll(() => playlistRows(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(before)
  }
)
