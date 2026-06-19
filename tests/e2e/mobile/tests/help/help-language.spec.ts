import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, CYRILLIC } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Help content follows the app language: booted in Russian, the Help dialog's
// table of contents renders in Russian (Cyrillic).
test(
  qase(125, caseTitle(125)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "ru")
    await gotoTab(page, "settings")

    const dialog = page.locator("ion-modal.help-dialog")
    await step(page, 125, 0, async () => {
      await page.locator("ion-item", { hasText: "Открыть справку" }).click()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 125, 1, async () => {
      // The TOC page titles are localized → Cyrillic under a Russian UI.
      const tocText = await dialog.locator("ion-list").innerText()
      expect(CYRILLIC.test(tocText)).toBe(true)
    })
  }
)
