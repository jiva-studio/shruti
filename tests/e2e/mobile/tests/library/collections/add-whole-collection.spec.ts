import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, playlistRows } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// "Add all" on a collection confirms, then adds every (language-filtered) track
// to the playlist in one batch. We assert the confirm dialog and that the queue
// grows (exact count is the language-filtered collection size).
test(
  qase(40, caseTitle(40)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Empty playlist (clean user.db): after "Add all" the queue holds exactly
    // the collection's (language-filtered) lectures — the screenshot is the
    // batch we added, not a seeded queue plus the batch.
    await boot(page, "en", { userDb: "clean" })

    await gotoTab(page, "search")
    const card = page.locator(".carousel-section .collection-card").first()
    await card.waitFor({ state: "visible", timeout: 20_000 })
    await card.click()
    await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
    await page.waitForTimeout(800)

    const alert = page.locator("ion-alert")

    await step(page, 40, 0, async () => {
      // Toolbar "Add collection" (add-all).
      await page.locator('[aria-label="Add collection"]').click()

      // The "Add N lectures?" alert.
      await expect(alert).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 40, 1, async () => {
      // Confirm the "Add N lectures?" alert.
      await alert.locator("button", { hasText: /^Ok$/ }).click()

      await gotoTab(page, "home")
      await expect
        .poll(() => playlistRows(page).count(), { timeout: 15_000 })
        .toBeGreaterThan(0)
    })

    await step(page, 40, 2, async () => {
      // Adding a whole collection is what records the provenance the Home
      // grouping reads, so this is the one place the running order is stated:
      // a run of lectures inside an otherwise mixed queue needs to say where
      // in the cycle it sits. The numbers come from the catalog, not from the
      // queue — counting rows would renumber the rest the moment one is played
      // or archived — so they start at one and follow the collection's order.
      const positions = playlistRows(page).locator(".position")
      await expect(positions.first()).toBeVisible({ timeout: 15_000 })
      await expect(positions.nth(0)).toHaveText("1")
      await expect(positions.nth(1)).toHaveText("2")
    })
  }
)
