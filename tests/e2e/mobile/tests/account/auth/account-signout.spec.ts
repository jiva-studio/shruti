import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Signing out clears the session: the account row reverts from the profile name
// to the anonymous sign-in prompt.
test(
  qase(113, caseTitle(113)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    await boot(page)

    await step(page, 113, 0, async () => {
      await gotoTab(page, "settings")

      await expect(page.getByText("E2E Tester")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 113, 1, async () => {
      await page.locator("ion-item", { hasText: "E2E Tester" }).click()

      await page.getByRole("button", { name: /sign out/i }).click()

      // The profile name is gone (back to anonymous).
      await expect(page.getByText("E2E Tester")).toBeHidden({ timeout: 15_000 })
    })
  }
)
