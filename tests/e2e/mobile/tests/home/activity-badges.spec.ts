import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase(12, caseTitle(12)), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await step(page, 12, 0, async () => {
    await boot(page)

    // The seeded listening history drives the activity tracker: the heatmap, a
    // completed-lectures count and a total-time-listened badge. (The current-streak
    // badge is deliberately not asserted — it only shows when the user listened on
    // consecutive days ending today, so it holds on the day the fixtures were
    // generated and lapses the day after; these two are cumulative and so stay
    // true however old the fixture is.)
    await expect(page.locator(".activity-card")).toBeVisible({ timeout: 20_000 })
    // Both badges are addressed by their `title`, the accessible label each one
    // carries: all three stats render through one `ActivityStatBadge` with no
    // per-badge class. The titles are the English fixture's, which is the locale
    // `boot()` comes up in.
    await expect(page.getByTitle("Lectures finished")).toBeVisible()
    await expect(page.getByTitle("Total time listened")).toBeVisible()
  })
})
