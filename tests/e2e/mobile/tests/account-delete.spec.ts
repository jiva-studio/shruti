import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// Deleting the account asks first WHICH delete (wipe local data or keep it). We
// drive the UI up to that choice (without confirming — the actual delete hits
// the backend).
test(
  qase(110, "Delete account with and without local wipe"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    await boot(page)
    await gotoTab(page, "settings")

    await page.locator("ion-item", { hasText: "E2E Tester" }).click()

    // First sheet → Delete account.
    await page.getByRole("button", { name: "Delete account", exact: true }).click()

    // Second sheet offers wipe vs keep.
    await expect(page.getByRole("button", { name: /wipe data/i })).toBeVisible({ timeout: 10_000 })
  }
)
