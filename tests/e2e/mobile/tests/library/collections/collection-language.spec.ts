import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A curated collection can mix languages, but it must only surface tracks the
 * user can actually consume in their library language (PR #1005,
 * CollectionView). On a Russian library the collection's English-only tracks are
 * filtered out, so every row that remains is a Russian lecture.
 */
test(
  qase(41, caseTitle(41)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await gotoTab(page, "search")

    await step(page, 41, 0, async () => {
      // Open the first collection card in a discovery carousel.
      const card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
      await card.click()
      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })

      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    })

    await step(page, 41, 1, async () => {
      // Once the language filter settles the collection lists only Russian rows —
      // its English-only tracks have been dropped.
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })
  }
)
