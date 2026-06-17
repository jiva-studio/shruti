import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"

test("home · non-empty playlist shows a nag banner", { tag: ["@offline", "@home"] }, async ({ page }) => {
  // Boot WITHOUT pre-dismissing the nags: the seeded playlist is non-empty and
  // notifications aren't granted on web, so the "enable reminders" banner shows.
  await boot(page, "en", { dismissNags: false })

  await expect(page.locator(".nag-banner").first()).toBeVisible({ timeout: 20_000 })
})
