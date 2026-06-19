import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootDeviceLocale } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Library filters badge — the pristine first-launch case.
 * `useSearchFiltersBinding.activeFilterCount` deliberately excludes the
 * locale-derived language + the default sort, so a fresh install reads 0 → the
 * header filter button stays inactive. (The "a pinned filter lights the badge"
 * side is covered as a step in the filters apply/reset case.)
 */
test.describe("library · pristine locale-seed", () => {
  // Drive the real first-launch language derivation from the device locale with
  // NO pinned source — the only thing set is the seeded (en) language, which
  // activeFilterCount ignores, so the badge must stay inactive.
  test.use({ locale: "en-US" })

  test(
    qase(28, caseTitle(28)),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      await bootDeviceLocale(page, "en")
      await openLibrary(page)

      await step(page, 28, 0, async () => {
        const button = page.locator(".search-row-filter-button")
        await expect(button).toBeVisible({ timeout: 15_000 })
        // Give the binding time to hydrate before asserting the negative.
        await page.waitForTimeout(600)
        await expect(button).not.toHaveClass(/\bis-active\b/)
      })
    }
  )
})
