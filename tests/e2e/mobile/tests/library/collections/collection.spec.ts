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
    await boot(page)

    // Baseline the Home queue before navigating away.
    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
    const before = queued.length

    const rows = trackRows(page)
    let pick = -1

    await step(page, 38, 0, async () => {
      // Open the first collection from a discovery carousel; its track list shows.
      await gotoTab(page, "search")
      const card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
      await card.click()

      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
      // Let the Ionic page transition settle before reading/tapping rows.
      await page.waitForTimeout(800)
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })

      // Pick the first collection lecture not already in the queue.
      const n = await rows.count()
      for (let i = 0; i < n; i++) {
        const text = (await rows.nth(i).innerText()).trim()
        if (!queued.includes(text)) {
          pick = i
          break
        }
      }
      expect(pick, "expected an un-queued lecture in the collection").toBeGreaterThanOrEqual(0)
    })

    await step(page, 38, 1, async (capture) => {
      // Open the chosen lecture's track sheet and tap Add — screenshot the sheet
      // first because tapping Add dismisses it.
      await openTrackSheet(page, rows.nth(pick))
      await expect(trackSheet(page).locator(".add-btn")).toBeVisible()
      await capture()
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 38, 2, async () => {
      // Back on Home the queue has grown by exactly one.
      await gotoTab(page, "home")
      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 1)
    })
  }
)
