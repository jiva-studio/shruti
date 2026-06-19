import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(
  qase(38, caseTitle(38)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "search")

    let card = page.locator(".carousel-section .collection-card").first()
    await step(page, 38, 0, async () => {
      // Tap the first collection card in a discovery carousel.
      card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
    })

    await step(page, 38, 1, async () => {
      await card.click()

      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
      await page.waitForTimeout(500) // settle the page transition before reading rows
      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    })
  }
)
