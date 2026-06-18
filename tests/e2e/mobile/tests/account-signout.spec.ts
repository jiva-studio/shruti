import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// Signing out clears the session: the account row reverts from the profile name
// to the anonymous sign-in prompt.
test(
  qase(113, "Sign out"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    await boot(page)
    await gotoTab(page, "settings")

    await expect(page.getByText("E2E Tester")).toBeVisible({ timeout: 10_000 })
    await page.locator("ion-item", { hasText: "E2E Tester" }).click()

    await page.getByRole("button", { name: /sign out/i }).click()

    // The profile name is gone (back to anonymous).
    await expect(page.getByText("E2E Tester")).toBeHidden({ timeout: 15_000 })
  }
)
