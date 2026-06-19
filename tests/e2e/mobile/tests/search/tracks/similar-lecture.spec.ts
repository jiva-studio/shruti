import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Tapping a "Similar by topic" lecture in the track sheet swaps the card to that
// lecture in place (the same sheet re-opens with new content).
test(
  qase(139, caseTitle(139)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await openLibrary(page)

    const sheet = trackSheet(page)
    let before = ""
    await step(page, 139, 0, async () => {
      // Find a track whose sheet shows a Similar-by-topic list.
      const rows = trackRows(page)
      const n = Math.min(await rows.count(), 8)
      let opened = false
      for (let i = 0; i < n; i++) {
        await openTrackSheet(page, rows.nth(i))
        const similar = trackSheet(page).locator(".similar")
        if (await similar.count()) {
          await similar.scrollIntoViewIfNeeded()
          if (await similar.locator(".track").first().isVisible().catch(() => false)) {
            opened = true
            break
          }
        }
        await trackSheet(page).locator(".close-button").click()
        await expect(trackSheet(page)).toBeHidden()
      }
      expect(opened, "expected a track with a similar-by-topic list").toBe(true)

      before = (await sheet.locator(".sheet-title").innerText()).trim()
    })

    await step(page, 139, 1, async () => {
      await sheet.locator(".similar .track").first().click()

      // The card stays open and swaps to the tapped lecture (title changes).
      await expect(sheet).toBeVisible()
      await expect
        .poll(async () => (await sheet.locator(".sheet-title").innerText()).trim(), { timeout: 10_000 })
        .not.toBe(before)
    })
  }
)
