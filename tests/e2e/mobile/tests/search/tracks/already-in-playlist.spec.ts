import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Once a track is in the playlist, the sheet's primary button must not offer to
 * add it again: it goes disabled and reads "Already in playlist". This drives
 * the none → added transition explicitly (add a not-yet-queued lecture), then
 * re-opens the SAME lecture and asserts the button state.
 */
test(
  qase(29, caseTitle(29)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    const rows = trackRows(page)
    let title = ""
    await step(page, 29, 0, async () => {
      const first = rows.first()
      title = (await first.locator(".title").innerText()).trim()

      // Add it via the sheet's primary button (enabled at first).
      await openTrackSheet(page, first)
      const addBtn = trackSheet(page).locator(".add-btn")
      await expect(addBtn).not.toHaveClass(/button-disabled/)
      await addBtn.click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 29, 1, async () => {
      // Re-open the SAME lecture: the primary button is now disabled and reads
      // "Already in playlist".
      const sameRow = rows.filter({ hasText: title }).first()
      await openTrackSheet(page, sameRow)
      const reopened = trackSheet(page).locator(".add-btn")
      await expect(reopened).toHaveClass(/button-disabled/)
      await expect(reopened).toHaveText(/Already in playlist/)
    })
  }
)
