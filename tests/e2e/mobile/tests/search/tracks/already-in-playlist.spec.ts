import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The track-row lifecycle in one case: open a not-yet-queued lecture's sheet
// (the card with Add / Share), tap Add (the row gains a download indicator),
// then re-open the same lecture (the primary button is disabled and reads
// "Already in playlist").
test(
  qase(29, caseTitle(29)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Empty playlist (clean user.db): the first library row is un-queued, so Add
    // is enabled — and the row's later "Already in playlist" state is the only
    // queued track on screen, not lost among a seeded queue.
    await boot(page, "en", { userDb: "clean" })

    let title = ""

    await step(page, 29, 0, async () => {
      await openLibrary(page)
      const rows = trackRows(page)
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })
      title = (await rows.first().locator(".title").innerText()).trim()

      // The track sheet (card) shows a title and the Add / Share actions.
      await openTrackSheet(page, rows.first())
      const sheet = trackSheet(page)
      await expect(sheet.locator(".sheet-title")).not.toHaveText("")
      await expect(sheet.locator(".add-btn")).toBeVisible()
      await expect(sheet.locator(".share-btn")).toBeVisible()
      await expect(sheet.locator(".add-btn")).not.toHaveClass(/button-disabled/)
    })

    await step(page, 29, 1, async (capture) => {
      // Tap Add — the sheet closes and the row gains a download indicator
      // (downloading radial / added / completed icon).
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
      const row = trackRows(page).filter({ hasText: title }).first()
      await expect(row.locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|downloading|completed/,
        { timeout: 15_000 }
      )
      // Screenshot the library row with its download indicator.
      await capture()
    })

    await step(page, 29, 2, async () => {
      // Re-open the SAME lecture: the primary button is now disabled and reads
      // "Already in playlist".
      const row = trackRows(page).filter({ hasText: title }).first()
      await openTrackSheet(page, row)
      const reopened = trackSheet(page).locator(".add-btn")
      await expect(reopened).toHaveClass(/button-disabled/)
      await expect(reopened).toHaveText(/Already in playlist/)
    })
  }
)
