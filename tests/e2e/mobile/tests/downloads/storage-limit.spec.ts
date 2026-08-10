import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * What happens at the storage limit, on both sides of it.
 *
 * A notice belongs to an interaction. The background queue hitting a wall it
 * was always going to hit is not news — that toast greeted the user on every
 * launch of a library already at the cap — so the queue now says nothing and
 * the row carries the state instead. A lecture the budget refused must not
 * look like one that is saved: it will not play in airplane mode, and before
 * it had its own state it rendered exactly like a downloaded row.
 *
 * The deliberate tap is the other side: that one is answered, always, and the
 * answer carries the way past for that single lecture.
 */
const TINY_LIMIT_BYTES = 1024 * 1024 // 1 MB; fixture lectures are 27-35 MB

test(qase(184, caseTitle(184)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await page.addInitScript((limit) => {
    localStorage.setItem("CapacitorStorage.settings.downloadLimitBytes", String(limit))
  }, TINY_LIMIT_BYTES)
  await boot(page, "en", { userDb: "clean" })

  await step(page, 184, 0, async () => {
    // Add a lecture the budget cannot possibly fit.
    await openLibrary(page)
    await openTrackSheet(page, trackRows(page).first())
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 184, 1, async () => {
    // The queue refused it and said nothing about it...
    await gotoTab(page, "home")
    const row = playlistRows(page).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // ...and the row admits it is not kept offline, rather than reading as saved.
    await expect(row.locator('[data-testid="track-state"]')).toHaveAttribute(
      "data-state",
      "deferred",
      { timeout: 20_000 }
    )
    await expect(page.locator("ion-toast")).toHaveCount(0)
  })

  await step(page, 184, 2, async (capture) => {
    // A tap the user is waiting on IS answered, and the answer carries a way past.
    await playlistRows(page).first().click()
    const toast = page.locator("ion-toast")
    await expect(toast).toBeVisible({ timeout: 20_000 })
    await capture()
    await toast.getByRole("button", { name: "Download anyway" }).click()
  })

  await step(page, 184, 3, async () => {
    // The grant is spent on that one lecture: it leaves the refused state.
    // Asserted by absence rather than by another value — the row starts
    // playing on the same tap, and a playing row swaps the icon for a radial
    // that carries no state attribute at all.
    await expect(playlistRows(page).first().locator('[data-state="deferred"]')).toHaveCount(0, {
      timeout: 30_000,
    })
  })
})
