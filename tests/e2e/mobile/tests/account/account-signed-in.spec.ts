import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// A signed-in user sees their profile on the account row, and tapping it offers
// Sign out / Delete account.
test(
  qase(109, caseTitle(109)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    await boot(page, "en", { userDb: "clean" })

    let row
    await step(page, 109, 0, async () => {
      await gotoTab(page, "settings")

      row = page.locator("ion-item", { hasText: "E2E Tester" })
      await row.scrollIntoViewIfNeeded()
      await expect(row).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 109, 1, async () => {
      await row.click()

      await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({ timeout: 10_000 })
      await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeVisible()
    })
  }
)
