import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootDeviceLocale } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Library filters badge — the pristine first-launch case.
 * `useSearchFiltersBinding` deliberately excludes the locale-derived language
 * and the default sort from what counts as filtering, so a fresh install shows
 * no active filters: the button above the results stays inactive and no chip
 * appears beside it. (The "a pinned filter lights it up" side is covered as a
 * step in the filters apply/reset case.)
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
      await bootDeviceLocale(page, "en", { userDbStrategy: "clean" })
      await openLibrary(page)

      await step(page, 28, 0, async () => {
        const button = page.locator(".filters-button")
        await expect(button).toBeVisible({ timeout: 15_000 })
        // Give the binding time to hydrate before asserting the negative.
        await page.waitForTimeout(600)
        await expect(button).not.toHaveClass(/\bis-active\b/)
        // …and nothing the user did not choose is displayed as one.
        await expect(page.locator(".chip--filter")).toHaveCount(0)
      })
    }
  )
})
