import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import {
  deletePlaylistRow,
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  searchInput,
  trackRows,
  trackSheet,
} from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The completed "double-check" indicator (IconRosetteDiscountCheckFilled →
// `svg.tabler-icon-rosette-discount-check-filled`). A fresh/queued row uses a
// different icon (a progress radial), so the presence/absence of this exact
// class cleanly separates "completed" from a fresh playlist pass.
const COMPLETED_ICON = ".tabler-icon-rosette-discount-check-filled"

// The English fixture's only track whose latest session reached the end —
// "Kṛṣṇa the Original Person and Source of All Incarnations" — the deterministic
// "completed" entry. ASCII slice dodges diacritics.
const COMPLETED_TITLE = "Original Person and Source"

// Regression guard for SHRUTI-18/19. Three steps so the run shows each
// distinct state: the completed badge in the queue, the lifetime badge in the
// LIBRARY (survives archiving), and the FRESH re-added pass on Home (a progress
// radial, not the completed double-check).
test(
  qase(19, caseTitle(19)),
  { tag: ["@offline", "@home"] },
  async ({ page }) => {
    await boot(page, "en", { sourceIds: [] })

    await step(page, 19, 0, async (capture) => {
      // The completed track shows the double-check badge in the queue.
      const queueRow = playlistRows(page).filter({ hasText: COMPLETED_TITLE })
      await expect(queueRow.first()).toBeVisible({ timeout: 20_000 })
      await expect(queueRow.first().locator(COMPLETED_ICON)).toBeVisible()
      // Screenshot the queue row WITH its completion double-check before archiving.
      await capture()

      // Archive it — it leaves the active queue.
      await deletePlaylistRow(page, queueRow.first())
      await expect(playlistRows(page).filter({ hasText: COMPLETED_TITLE })).toHaveCount(0, {
        timeout: 15_000,
      })
    })

    await step(page, 19, 1, async () => {
      // In the library the lifetime completion badge survives the archive — the
      // row still carries the rosette double-check. (Auto-screenshot: this row.)
      await openLibrary(page)
      await searchInput(page).fill(COMPLETED_TITLE)
      const libRow = trackRows(page).filter({ hasText: COMPLETED_TITLE })
      await expect(libRow.first()).toBeVisible({ timeout: 15_000 })
      await expect(libRow.first().locator(COMPLETED_ICON)).toBeVisible()
    })

    await step(page, 19, 2, async (capture) => {
      // Re-add it from the library detail sheet.
      const libRow = trackRows(page).filter({ hasText: COMPLETED_TITLE })
      await openTrackSheet(page, libRow.first())
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      // Back on Home: the re-added queue row is a FRESH pass — a progress radial,
      // NOT the completed double-check. This is the bug being guarded.
      await gotoTab(page, "home")
      const readded = playlistRows(page).filter({ hasText: COMPLETED_TITLE })
      await expect(readded.first()).toBeVisible({ timeout: 20_000 })
      await expect(readded.first().locator(COMPLETED_ICON)).toHaveCount(0)
      // Screenshot Home with the fresh re-added row.
      await capture()

      // …and the library STILL keeps its lifetime badge after the re-add. The
      // search tab kept its `/tabs/search/tracks` stack, so return directly.
      await gotoTab(page, "search")
      await searchInput(page).fill(COMPLETED_TITLE)
      const libRow2 = trackRows(page).filter({ hasText: COMPLETED_TITLE })
      await expect(libRow2.first()).toBeVisible({ timeout: 15_000 })
      await expect(libRow2.first().locator(COMPLETED_ICON)).toBeVisible()
    })
  }
)
