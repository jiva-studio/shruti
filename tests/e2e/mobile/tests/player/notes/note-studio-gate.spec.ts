import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The "Share video" (Studio) entry on a note is Pro-gated: a free user tapping
// it opens the paywall.
test(
  qase(11, caseTitle(11)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    await step(page, 11, 0, async () => {
      await gotoTab(page, "notes")

      // Open a seeded note's action sheet → Share → Share video (Studio).
      await page.locator(".note[role=button]").first().click()
      await page.getByRole("button", { name: /^share$/i }).first().click()
    })

    await step(page, 11, 1, async () => {
      await page.getByRole("button", { name: /share video/i }).click()

      // Free user → the paywall opens.
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })
  }
)
