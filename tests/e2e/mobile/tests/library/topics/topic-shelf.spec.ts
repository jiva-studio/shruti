import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The library landing derives personalized topic shelves from listening
// history. Tapping a shelf's "See all" opens that topic's detail page with its
// full track list.
test(
  qase(44, caseTitle(44)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)

    // A topic shelf = a hashtag SectionHeader (with `#`) carrying a "See all".
    let seeAll = page
      .locator(".section-header", { has: page.locator(".hash") })
      .locator("button.section-more")

    await step(page, 44, 0, async () => {
      await gotoTab(page, "search")

      seeAll = page
        .locator(".section-header", { has: page.locator(".hash") })
        .locator("button.section-more")
      await expect(seeAll.first()).toBeVisible({ timeout: 20_000 })
    })

    await step(page, 44, 1, async () => {
      await seeAll.first().click()

      // The topic detail page opens with its track list.
      await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
      await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
    })
  }
)
