import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Opening a collection, tapping a lecture's sheet and adding it grows the Home
// queue (no success toast for a single add). Mirrors add-track.spec.ts but
// enters from a discovery collection card.
test(
  qase(39, caseTitle(39)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)

    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
    const before = queued.length

    const rows = trackRows(page)
    let pick = -1

    await step(page, 39, 0, async () => {
      // Open the first collection from a discovery carousel (see collection.spec.ts).
      await gotoTab(page, "search")
      const card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
      await card.click()
      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
      // Let the Ionic page transition settle before tapping a row.
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

    await step(page, 39, 1, async () => {
      await openTrackSheet(page, rows.nth(pick))
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 39, 2, async () => {
      await gotoTab(page, "home")
      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 1)
    })
  }
)
