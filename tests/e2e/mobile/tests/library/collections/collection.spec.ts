import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Open a collection card from a discovery carousel (its track list renders),
// then add one un-queued lecture from it via its track sheet — the Home queue
// grows by exactly one (no success toast for a single add).
test(
  qase(38, caseTitle(38)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Empty playlist (clean user.db): after the single add, Home holds exactly
    // that one lecture — the screenshot shows precisely what was added, with no
    // seeded queue to count against.
    await boot(page, "en", { userDb: "clean" })

    const rows = trackRows(page)

    await step(page, 38, 0, async () => {
      // Open the first collection from a discovery carousel; its track list shows.
      await gotoTab(page, "search")
      const card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
      await card.click()

      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
      // Let the Ionic page transition settle before reading/tapping rows.
      await page.waitForTimeout(800)
      // The playlist is empty, so the first collection lecture is un-queued.
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    })

    await step(page, 38, 1, async (capture) => {
      // Open the first lecture's track sheet and tap Add — screenshot the sheet
      // first because tapping Add dismisses it.
      await openTrackSheet(page, rows.first())
      await expect(trackSheet(page).locator(".add-btn")).toBeVisible()
      await capture()
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 38, 2, async () => {
      // Back on Home the queue holds exactly the one lecture we added.
      await gotoTab(page, "home")
      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(1)
    })
  }
)
