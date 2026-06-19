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
  await boot(page, "ru")

  // Baseline the Home queue before navigating away.
  await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
  const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
  const before = queued.length

  const rows = trackRows(page)
  let pick = -1

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
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })

    // Pick the first topic lecture not already in the queue.
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      const text = (await rows.nth(i).innerText()).trim()
      if (!queued.includes(text)) {
        pick = i
        break
      }
    }
    expect(pick, "expected an un-queued lecture in the topic").toBeGreaterThanOrEqual(0)
  })

  await step(page, 43, 1, async (capture) => {
    // Open the chosen lecture's track sheet and tap Add — screenshot the sheet
    // first because tapping Add dismisses it.
    await openTrackSheet(page, rows.nth(pick))
    await expect(trackSheet(page).locator(".add-btn")).toBeVisible()
    await capture()
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 43, 2, async () => {
    // Back on Home the queue has grown by exactly one.
    await gotoTab(page, "home")
    await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 1)
  })
})
