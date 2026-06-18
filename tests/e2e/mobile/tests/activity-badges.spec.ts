import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"

test(qase(12, "Activity widget appears after first track, hidden on fresh install"), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await boot(page)

  // The seeded listening history drives the activity tracker: the heatmap, a
  // completed-lectures count and a total-time-listened badge. (The current-streak
  // badge is deliberately NOT asserted — it only shows when the user listened on
  // consecutive days ENDING TODAY, which a fixed-date fixture can never satisfy as
  // real time moves on; these badges are cumulative and so stay deterministic.)
  await expect(page.locator(".activity-card")).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(".kit-badge.completed-badge")).toBeVisible()
  await expect(page.locator(".kit-badge", { hasText: /\d+\s*[hmdчмд]/i }).first()).toBeVisible()
})
