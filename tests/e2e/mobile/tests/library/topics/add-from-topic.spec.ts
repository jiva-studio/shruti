import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// From a topic page, opening a lecture's sheet and tapping Add grows the Home
// queue. Boots `ru` because the fixture's topics only hold Russian lectures
// (see topic.spec.ts / topic-language.spec.ts).
test(
  qase(46, caseTitle(46)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")

    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())
    const before = queued.length

    let rows = trackRows(page)
    let pick = -1

    await step(page, 46, 0, async () => {
      await gotoTab(page, "search")
      const tile = page.locator(".tile-grid > *").first()
      await tile.waitFor({ state: "visible", timeout: 20_000 })
      await tile.click()
      await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
      // Let the Ionic page transition settle — until it finishes the outgoing
      // SearchView's router-outlet intercepts taps on the topic rows.
      await page.waitForTimeout(800)

      rows = trackRows(page)
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })

      // Pick the first topic lecture not already queued (queued captured on Home).
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

    await step(page, 46, 1, async () => {
      await openTrackSheet(page, rows.nth(pick))
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 46, 2, async () => {
      await gotoTab(page, "home")
      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before + 1)
    })
  }
)
