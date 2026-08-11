import fs from "fs"
import { test, expect } from "../../../support/test.js"
import { boot } from "../../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { gotoTab, openTrackSheet, playlistRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The landing's personalized topic shelves are a discovery surface like every
// other shelf on the page, so a playing lecture has to read as the flat
// added/completed badge there too — not the progress radial the Home queue
// shows (#1615). The seeded profile is what produces shelves at all: a clean
// user db has no listening history and the section never renders.
test(
  qase(214, caseTitle(214)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)

    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        headers: { "content-length": String(mp3.length) },
        body: mp3,
      })
    )

    // A topic shelf: the hashtag SectionHeader plus the track list under it.
    // The topic TILE grid carries the same hashtag header but no track rows.
    const shelf = page
      .locator(".landing > div")
      .filter({ has: page.locator(".section-header .hash") })
      .filter({ has: page.locator("ion-item.track") })
      .first()

    let title = ""
    await step(page, 214, 0, async () => {
      await gotoTab(page, "search")
      const row = shelf.locator("ion-item.track").first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      title = (await row.locator(".title").innerText()).trim()

      // Shelf lectures are never already queued or completed — the recommender
      // excludes both — so the sheet's primary action is always "add" here.
      await openTrackSheet(page, row)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      await gotoTab(page, "home")
      const queued = playlistRows(page).filter({ hasText: title }).first()
      await queued.locator("ion-item.track").click()
      await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/, { timeout: 20_000 })
    })

    await step(page, 214, 1, async () => {
      await gotoTab(page, "search")
      // Back on the landing: the shelves are built once per load, so the row we
      // played is still there — now carrying the state the bug got wrong.
      const played = shelf.locator("ion-item.track").filter({ hasText: title }).first()
      await expect(played.locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })
  }
)
