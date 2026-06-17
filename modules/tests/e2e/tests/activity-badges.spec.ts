import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"

test("home · activity tracker badges", { tag: ["@offline", "@home"] }, async ({ page }) => {
  await boot(page)

  // The seeded listening history drives the activity tracker: a current streak,
  // a completed-lectures count and a total-time-listened badge.
  await expect(page.locator(".kit-badge.streak-badge")).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(".kit-badge.completed-badge")).toBeVisible()
  await expect(page.locator(".kit-badge", { hasText: /\d+\s*[hmdчмд]/i }).first()).toBeVisible()
})
