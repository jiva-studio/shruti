import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, searchInput } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The Search (library) landing surfaces its sections fully formed: collection-
// group carousels, the topics tile grid, an entry banner, and the docked search
// field that is now the way into the catalog. (The "Search the library" banner
// and its "all lectures" button are gone — the field replaced both.)
test(
  qase(34, caseTitle(34)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "search")

    await step(page, 34, 0, async () => {
      // Collection-group carousels.
      await expect(page.locator(".carousel-section").first()).toBeVisible({ timeout: 20_000 })
      // Topics tile grid.
      await expect(page.locator(".tile-grid").first()).toBeVisible({ timeout: 20_000 })
      // An entry banner (Smart Library / My Library).
      await expect(page.locator(".library-banner").first()).toBeVisible({ timeout: 20_000 })
      // The search field, docked below the landing rather than a screen away.
      await expect(searchInput(page)).toBeVisible({ timeout: 20_000 })
    })
  }
)
