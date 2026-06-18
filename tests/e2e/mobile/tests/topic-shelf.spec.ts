import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows } from "../support/nav.js"

// The library landing derives personalized topic shelves from listening
// history. Tapping a shelf's "See all" opens that topic's detail page with its
// full track list.
test(
  qase(44, "Open a topic from a shelf"),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "search")

    // A topic shelf = a hashtag SectionHeader (with `#`) carrying a "See all".
    const seeAll = page
      .locator(".section-header", { has: page.locator(".hash") })
      .locator("button.section-more")
    await expect(seeAll.first()).toBeVisible({ timeout: 20_000 })
    await seeAll.first().click()

    // The topic detail page opens with its track list.
    await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
  }
)
