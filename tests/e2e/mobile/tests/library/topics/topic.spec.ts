import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Open a topic tile from the Search-landing grid (its track list renders), then
// add one un-queued lecture from it via its track sheet — the Home queue grows
// by exactly one.
//
// Booted in Russian: the fixture's topics only hold Russian lectures, so an
// English library would (correctly) leave the topic page empty — see
// topic-language.spec for that language-filtering coverage. Booting ru gives a
// topic with lectures to navigate and add from.
test(qase(43, caseTitle(43)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  // Empty playlist (clean user.db): after the single add, Home holds exactly
  // that one lecture — the screenshot shows precisely what was added.
  await boot(page, "ru", { userDb: "clean" })

  const rows = trackRows(page)

  await step(page, 43, 0, async () => {
    await gotoTab(page, "search")

    // The discovery page has a grid of topic tiles; tap the first one.
    const tile = page.locator(".tile-grid > *").first()
    await tile.waitFor({ state: "visible", timeout: 20_000 })
    await tile.click()

    await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
    // Let the Ionic page transition settle — until it finishes the outgoing
    // SearchView's router-outlet intercepts taps on the topic rows.
    await page.waitForTimeout(800)
    // The playlist is empty, so the first topic lecture is un-queued.
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 43, 1, async (capture) => {
    // Open the first lecture's track sheet and tap Add — screenshot the sheet
    // first because tapping Add dismisses it.
    await openTrackSheet(page, rows.first())
    await expect(trackSheet(page).locator(".add-btn")).toBeVisible()
    await capture()
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 43, 2, async () => {
    // Back on Home the queue holds exactly the one lecture we added.
    await gotoTab(page, "home")
    await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(1)
  })
})
