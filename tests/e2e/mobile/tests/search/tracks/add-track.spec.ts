import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"

test(qase(29, "Track row goes from none to added"), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)

  // Snapshot the current queue. PlaylistRow and the library list both render the
  // same TrackListItem, so a track's innerText (title + meta line) matches
  // across the two surfaces — we use that to find a NOT-yet-queued lecture.
  await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
  const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
  const before = queued.length

  await openLibrary(page)

  // Pick the first library row that isn't already in the queue.
  const rows = trackRows(page)
  const n = await rows.count()
  let pickedIndex = -1
  for (let i = 0; i < n; i++) {
    const text = (await rows.nth(i).innerText()).trim()
    if (!queued.includes(text)) {
      pickedIndex = i
      break
    }
  }
  expect(pickedIndex, "expected at least one un-queued lecture in the library").toBeGreaterThanOrEqual(0)

  await openTrackSheet(page, rows.nth(pickedIndex))
  await trackSheet(page).locator(".add-btn").click()
  await expect(trackSheet(page)).toBeHidden()

  // Back on Home the queue is one longer.
  await gotoTab(page, "home")
  await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 1)
})
