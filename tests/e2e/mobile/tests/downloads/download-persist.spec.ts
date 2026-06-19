import fs from "fs"
import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedSearchFilter,
  preseedDismissedNags,
  preseedUserDbOnce,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// A completed download survives an app restart: the downloaded-state row
// rehydrates from the persisted user DB + the Cache-API blob, with no
// re-download. The user DB is seeded ONCE (only if absent) so the reload
// represents a real restart — not a harness re-seed that would wipe the
// runtime download row.
test(
  qase(75, caseTitle(75)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    // Seed the user DB only if absent, so a reload (= restart) keeps the
    // runtime-written media_items instead of clobbering them with the fixture.
    await preseedUserDbOnce(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        headers: { "content-length": String(mp3.length) },
        body: mp3,
      })
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    let title = ""
    const row = () => trackRows(page).filter({ hasText: title }).first()

    await step(page, 75, 0, async () => {
      await openLibrary(page)
      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      await expect(row().locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })

    await step(page, 75, 1, async () => {
      // Restart.
      await page.reload()
      await page.waitForURL("**/tabs/home", { timeout: 60_000 })
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await openLibrary(page)

      // The downloaded state rehydrated — still added, no re-download needed.
      await expect(row().locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })
  }
)
