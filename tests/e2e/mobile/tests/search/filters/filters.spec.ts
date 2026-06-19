import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(25, caseTitle(25)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await step(page, 25, 0, async () => {
    await page.locator(".search-row-filter-button").click()
    // Scope to the presented overlay — an Ionic page transition can briefly
    // leave a dismissed (`.overlay-hidden`) filters modal from the previous
    // SearchView instance in the DOM, which a bare class match would clash with.
    await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({ timeout: 10_000 })
  })
})
