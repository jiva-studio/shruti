import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { openLibrary } from "../support/nav.js"

test("library · filters sheet opens", { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await page.locator(".search-row-filter-button").click()
  await expect(page.locator("ion-modal.filters-sheet")).toBeVisible({ timeout: 10_000 })
})
