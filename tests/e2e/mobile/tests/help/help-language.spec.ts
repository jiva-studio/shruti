import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, CYRILLIC } from "../../support/nav.js"

// Help content follows the app language: booted in Russian, the Help dialog's
// table of contents renders in Russian (Cyrillic).
test(
  qase(125, "Help content follows the app language"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "ru")
    await gotoTab(page, "settings")

    await page.locator("ion-item", { hasText: "Открыть справку" }).click()
    const dialog = page.locator("ion-modal.help-dialog")
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // The TOC page titles are localized → Cyrillic under a Russian UI.
    const tocText = await dialog.locator("ion-list").innerText()
    expect(CYRILLIC.test(tocText)).toBe(true)
  }
)
