import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openLibrary } from "../../support/nav.js"
import { installDiscoveryMock, DEFAULT_DISCOVERY_HITS } from "../../support/discovery-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A failure is not an answer.
 *
 * The lane remembers the words it last asked for so that coming back to the
 * page does not re-buy an answer it is already showing. A search that failed
 * shows nothing, so the words behind it were never answered — remembering them
 * leaves "archives unavailable" standing for words that would work, and the
 * lane has no retry button of its own (#1842).
 */

test(qase(500, caseTitle(500)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await installDiscoveryMock(page, { status: 503 })
  await openLibrary(page)

  await step(page, 500, 0, async () => {
    await expect(page.locator(".lane .lane-state--muted")).toHaveText(
      "Couldn't reach the internet search right now.",
      { timeout: 20_000 }
    )
  })

  await step(page, 500, 1, async () => {
    // The reader comes back — a phone off wifi for a moment, a service
    // restarted. Nothing about the search changed, so the only gesture that can
    // ask again is leaving the tab and returning to it.
    await installDiscoveryMock(page, { hits: DEFAULT_DISCOVERY_HITS })
    await gotoTab(page, "home")
    await gotoTab(page, "search")

    await expect(page.locator(".carousel-cell .track-tile").first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.locator(".lane .lane-state--muted")).toHaveCount(0)
  })
})
