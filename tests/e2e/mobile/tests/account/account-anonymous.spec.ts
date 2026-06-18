import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"

// An anonymous (not signed-in) user sees a "Sign in" call-to-action on the
// account row. (Default boot is anonymous + non-Pro.)
test(
  qase(108, "Anonymous account row prompts sign-in"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const row = page.locator("ion-item", { hasText: "Sign in" }).first()
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 10_000 })
  }
)
