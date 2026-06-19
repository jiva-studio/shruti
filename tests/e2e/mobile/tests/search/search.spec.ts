import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, searchInput, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase([20, 22], caseTitle(20)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await step(page, 20, 0, async () => {
    // The Bhagavad-gita-filtered library starts populated.
    await expect(trackRows(page).first()).toBeVisible()
    expect(await trackRows(page).count()).toBeGreaterThan(0)

    // A query that can't match anything empties the list — proves the box is
    // wired to the result set without depending on specific catalog content.
    await searchInput(page).fill("zzzqqxnomatch")
    await expect(trackRows(page)).toHaveCount(0, { timeout: 15_000 })

    // Clearing it brings the catalog back.
    await searchInput(page).fill("")
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
  })
})
