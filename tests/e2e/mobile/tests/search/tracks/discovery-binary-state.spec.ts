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
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../../support/nav.js"

// A playing/queued track shows a single "added" checkmark in the discovery
// surfaces (Search/Library) — the live progress radial is reserved for the Home
// queue. We add a Library track, play it from the Home queue (giving it live
// progress), and confirm the Home row carries a radial (no icon testid) while
// the same Library row folds to the binary "added" icon.
test(
  qase(32, "Discovery surfaces fold playback progress to a binary state"),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await interceptContent(page)
    await preseedUserDb(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        headers: { "content-length": String(mp3.length) },
        body: mp3,
      })
    )

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    // Add a Library track so it's queued; play it so it has live progress.
    await openLibrary(page)
    const first = trackRows(page).first()
    const title = (await first.locator(".title").innerText()).trim()
    await openTrackSheet(page, first)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    // Library row: a queued/playing track folds to the binary "added" icon
    // (testid present, data-state added/completed) — not a progress radial.
    const libRow = trackRows(page).filter({ hasText: title }).first()
    await expect(libRow.locator('[data-testid="track-state"]')).toHaveAttribute(
      "data-state",
      /added|completed/,
      { timeout: 30_000 }
    )

    // The Home queue, by contrast, shows the live progress radial for the same
    // track once it's playing — so the icon testid is absent there.
    await gotoTab(page, "home")
    const queued = playlistRows(page).filter({ hasText: title }).first()
    await queued.locator("ion-item.track").click()
    await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/, { timeout: 20_000 })
    await expect(queued.locator('[data-testid="track-state"]')).toHaveCount(0)
  }
)
