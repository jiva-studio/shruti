import fs from "fs"
import { test, expect } from "../../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import {
  deletePlaylistRow,
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Cancelling a track while its download is in flight removes it cleanly: the
// in-progress transfer is abandoned and the row leaves the playlist. We hang
// the audio transfer so the download stays mid-flight, then delete the queue row.
test(
  qase(140, caseTitle(140)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    // Empty playlist (clean user.db): adding then cancelling the one track takes
    // the queue 1 → 0, so the cancel is the whole story in the screenshot.
    await preseedUserDb(page, "en", "clean")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    // Hang every audio transfer so the added track stays "downloading".
    await page.route("**/public/tracks/*/audio/*", () => {
      /* never respond — the transfer is permanently in flight */
      void mp3
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    let title = ""
    const queued = () => playlistRows(page).filter({ hasText: title }).first()
    await step(page, 140, 0, async () => {
      // Add the first library track; its audio download hangs.
      await openLibrary(page)
      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      // It's queued and mid-download (the icon indicator gave way to the radial).
      await gotoTab(page, "home")
      await expect(queued()).toBeVisible({ timeout: 20_000 })
      await expect(queued().locator('[data-testid="track-state"]')).toHaveCount(0, {
        timeout: 30_000,
      })
    })

    await step(page, 140, 1, async () => {
      // Cancel it from the queue while the transfer is still hanging.
      await deletePlaylistRow(page, queued())

      // The track left the playlist — the cancel removed it cleanly.
      await expect(playlistRows(page).filter({ hasText: title })).toHaveCount(0, {
        timeout: 20_000,
      })
    })
  }
)
