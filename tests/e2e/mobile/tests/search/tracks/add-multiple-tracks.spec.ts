import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Adding several tracks one after another grows the Home queue by that many,
// each appended (prefetch is serialized, FIFO). Extends add-track.spec.ts (29)
// from a single add to a multi-add.
test(
  qase(33, caseTitle(33)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Empty playlist (clean user.db): the queue starts at zero, so the two
    // tracks we add are the only rows on Home — the screenshot shows exactly
    // what the test did, with no seeded queue to disambiguate against.
    await boot(page, "en", { userDb: "clean" })

    const added: string[] = []
    await step(page, 33, 0, async () => {
      await openLibrary(page)

      // The playlist is empty, so the first two library rows are both un-queued.
      const rows = trackRows(page)
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })
      for (const idx of [0, 1]) {
        added.push((await rows.nth(idx).locator(".title").innerText()).trim())
        await openTrackSheet(page, rows.nth(idx))
        await trackSheet(page).locator(".add-btn").click()
        await expect(trackSheet(page)).toBeHidden()
      }
    })

    await step(page, 33, 1, async () => {
      await gotoTab(page, "home")
      // Started empty → the queue is exactly the two tracks we added.
      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(2)
      const titles = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
      for (const a of added) {
        expect(titles.some((t) => t.includes(a)), `queue should contain "${a}"`).toBe(true)
      }
    })
  }
)
