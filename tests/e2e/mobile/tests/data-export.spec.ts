import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// Exporting the user database produces a downloadable file (web path).
test(
  qase(121, "Export and import the database"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const exportRow = page.locator("ion-item", { hasText: "Export user data" })
    await exportRow.scrollIntoViewIfNeeded()
    await expect(exportRow).toBeVisible({ timeout: 10_000 })

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      exportRow.click(),
    ])
    expect(download.suggestedFilename().length).toBeGreaterThan(0)
  }
)
