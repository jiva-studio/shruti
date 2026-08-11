import fs from "fs"
import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import {
  deletePlaylistRow,
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A cancelled download must release the track, not just the row.
 *
 * Case 140 already covers the row leaving the queue. What it cannot see is the
 * thing that was actually wrong: the cancelled transfer never settled its
 * promise, so the track's in-flight slot stayed occupied — and adding the same
 * lecture again joined a transfer that would never finish. The row sat on
 * "downloading" forever, with no way out but a restart.
 *
 * The cancel is deliberately issued once the transfer is genuinely in flight
 * (the row has swapped its icon for the radial). Cancelling earlier exercises
 * the pre-transfer window instead, which is a different defect.
 */
test(qase(185, caseTitle(185)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedOnboardingDone(page)
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  const mp3 = fs.readFileSync(SILENT_MP3_PATH)
  let serveAudio = false
  let audioHits = 0
  await page.route("**/public/tracks/*/audio/*", (route) => {
    audioHits++
    // Hanging first, so the cancel lands mid-transfer; serving afterwards, so
    // the re-add can only succeed if the slot was actually released.
    if (!serveAudio) return
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
  const queued = () => playlistRows(page).filter({ hasText: title }).first()

  await step(page, 185, 0, async () => {
    await openLibrary(page)
    const first = trackRows(page).first()
    title = (await first.locator(".title").innerText()).trim()
    await openTrackSheet(page, first)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    // Mid-download: the icon indicator has given way to the radial.
    await gotoTab(page, "home")
    await expect(queued()).toBeVisible({ timeout: 20_000 })
    await expect(queued().locator('[data-testid="track-state"]')).toHaveCount(0, {
      timeout: 30_000,
    })
  })

  await step(page, 185, 1, async () => {
    // Cancel it while the transfer is still hanging.
    await deletePlaylistRow(page, queued())
    await expect(playlistRows(page).filter({ hasText: title })).toHaveCount(0, { timeout: 20_000 })
  })

  await step(page, 185, 2, async () => {
    // Add the very same lecture again, with the transfer now able to finish.
    serveAudio = true
    const before = audioHits
    await openLibrary(page)
    const again = trackRows(page).filter({ hasText: title }).first()
    await openTrackSheet(page, again)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    // The re-add must actually reach the network. If the cancelled transfer
    // still owned the track's slot, this second add would silently join the
    // abandoned promise and never ask for the file at all.
    await expect
      .poll(() => audioHits - before, { timeout: 30_000 })
      .toBeGreaterThan(0)

    // And it finishes. Read on the Library row: the Home queue draws a
    // PLAYBACK radial for a queued track, so the state icon is absent there
    // whether the file arrived or not — which is what made the tail of this
    // look stuck (#1680).
    await expect(
      trackRows(page).filter({ hasText: title }).first().locator('[data-testid="track-state"]')
    ).toHaveAttribute("data-state", /added|completed/, { timeout: 45_000 })
  })

  await step(page, 185, 3, async () => {
    // And it is queued again, under its own row.
    await gotoTab(page, "home")
    await expect(queued()).toBeVisible({ timeout: 20_000 })
  })
})
