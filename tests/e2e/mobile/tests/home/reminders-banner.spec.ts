import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase(14, caseTitle(14)), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await step(page, 14, 0, async () => {
    // Boot WITHOUT pre-dismissing the nags: the seeded playlist is non-empty and
    // notifications aren't granted on web, so the "enable reminders" banner shows.
    await boot(page, "en", { dismissNags: false })

    await expect(page.locator(".nag-banner").first()).toBeVisible({ timeout: 20_000 })
  })
})
