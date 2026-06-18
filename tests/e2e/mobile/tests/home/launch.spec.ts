import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { playlistRows } from "../../support/nav.js"

test(qase(145, "Launches to a populated Home"), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await boot(page)

  // Booted past Welcome onto the Home tab with the bottom nav rendered.
  await expect(page).toHaveURL(/\/tabs\/home/)
  await expect(page.locator("ion-tab-bar")).toBeVisible()

  // The seeded user.db carries ~9 playlist tracks → "Up Next" shows rows.
  await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
  expect(await playlistRows(page).count()).toBeGreaterThan(0)
})
