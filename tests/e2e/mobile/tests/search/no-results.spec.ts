import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, searchInput, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// A search that matches nothing shows the centered empty state (icon + title +
// hint + a "change filters" action), with no track rows.
test(
  qase(24, caseTitle(24)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    await step(page, 24, 0, async () => {
      await searchInput(page).fill("zzzqqxnomatch")

      await expect(page.locator(".no-results")).toBeVisible({ timeout: 15_000 })
      await expect(page.locator(".no-results-title")).toBeVisible()
      await expect(trackRows(page)).toHaveCount(0)
    })
  }
)
