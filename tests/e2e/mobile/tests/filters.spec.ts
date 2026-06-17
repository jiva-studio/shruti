import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { openLibrary } from "../support/nav.js"

test("library · filters sheet opens", { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await page.locator(".search-row-filter-button").click()
  // Scope to the presented overlay — an Ionic page transition can briefly
  // leave a dismissed (`.overlay-hidden`) filters modal from the previous
  // SearchView instance in the DOM, which a bare class match would clash with.
  await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({ timeout: 10_000 })
})
