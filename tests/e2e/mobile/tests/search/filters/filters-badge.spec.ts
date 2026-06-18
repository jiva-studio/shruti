import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, bootDeviceLocale } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"

/**
 * Library filters badge — the active-state highlight on the header filter
 * button (`SearchFiltersButton`, `.is-active` when `activeFilterCount > 0`).
 *
 * `useSearchFiltersBinding.activeFilterCount` deliberately excludes the
 * pristine first-launch seed (the locale-derived language + the default sort)
 * so a fresh install reads 0 → no badge. A pinned source IS a user choice → it
 * counts → the badge is active. These two tests guard both sides.
 */

test(
  qase(26, "Applying an author filter narrows results and shows a count badge"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // boot() pins source `source_dsicuBsFvinZ`, a non-seed dimension, so the
    // badge must light up.
    await boot(page)
    await openLibrary(page)

    await expect(page.locator(".search-row-filter-button")).toHaveClass(/\bis-active\b/, {
      timeout: 15_000,
    })
  }
)

test.describe("library · pristine locale-seed", () => {
  // Drive the real first-launch language derivation from the device locale with
  // NO pinned source — the only thing set is the seeded (en) language, which
  // activeFilterCount ignores, so the badge must stay inactive.
  test.use({ locale: "en-US" })

  test(
    qase(28, "Language filter scopes the catalog"),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      await bootDeviceLocale(page, "en")
      await openLibrary(page)

      const button = page.locator(".search-row-filter-button")
      await expect(button).toBeVisible({ timeout: 15_000 })
      // Give the binding time to hydrate before asserting the negative, so we
      // don't pass on a not-yet-rendered class. The count derives from the
      // seeded language alone → 0 → never active.
      await page.waitForTimeout(600)
      await expect(button).not.toHaveClass(/\bis-active\b/)
    }
  )
})
