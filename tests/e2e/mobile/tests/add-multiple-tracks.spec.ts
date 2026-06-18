import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../support/nav.js"

// Adding several tracks one after another grows the Home queue by that many,
// each appended (prefetch is serialized, FIFO). Extends add-track.spec.ts (29)
// from a single add to a multi-add.
test(
  qase(33, "Add multiple tracks"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)

    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
    const before = queued.length

    await openLibrary(page)

    // Pick the first two library rows that aren't already queued.
    const rows = trackRows(page)
    const n = await rows.count()
    const picks: number[] = []
    for (let i = 0; i < n && picks.length < 2; i++) {
      const text = (await rows.nth(i).innerText()).trim()
      if (!queued.includes(text)) picks.push(i)
    }
    expect(picks.length, "expected at least two un-queued lectures in the library").toBe(2)

    for (const idx of picks) {
      await openTrackSheet(page, rows.nth(idx))
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    }

    await gotoTab(page, "home")
    await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 2)
  }
)
