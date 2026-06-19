import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { playFirstQueuedTrack } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase([16, 54], caseTitle(16)), { tag: ["@offline", "@player"] }, async ({ page }) => {
  await boot(page)

  await step(page, 16, 0, async () => {
    // Tapping a queued track loads the (stubbed valid) audio and un-hides the
    // floating player — the observable "now playing" transition.
    await playFirstQueuedTrack(page)
    await expect(page.locator(".player")).toBeVisible()
  })
})
