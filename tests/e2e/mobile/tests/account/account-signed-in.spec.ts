import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"

// A signed-in user sees their profile on the account row, and tapping it offers
// Sign out / Delete account.
test(
  qase(109, "Signed-in account row shows profile and manage options"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    await boot(page)
    await gotoTab(page, "settings")

    const row = page.locator("ion-item", { hasText: "E2E Tester" })
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.click()

    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeVisible()
  }
)
