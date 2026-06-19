import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

test(
  qase(15, caseTitle(15)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // SectionHeader renders the "see all" chevron as `.section-more`. The first
    // one on the landing is a collection-GROUP carousel (`topGroups`) when the
    // fixture has groups; otherwise it's the "others / all collections" header.
    // Both land on CollectionListView, which renders `.collection-row` cards.
    const seeAll = page.locator(".section-more").first()

    await step(page, 15, 0, async () => {
      await boot(page)
      await gotoTab(page, "search")

      await seeAll.waitFor({ state: "visible", timeout: 20_000 })
    })

    await step(page, 15, 1, async () => {
      await seeAll.click()

      // Settle on whichever list route the fixture surfaces.
      await page.waitForURL(/\/search\/(collection-group\/|collections)/, { timeout: 10_000 })
      const url = page.url()
      test.info().annotations.push({
        type: "route",
        description: /collection-group\//.test(url) ? "collection-group" : "all-collections",
      })

      // Either route renders collection cards via CollectionListItem (`.collection-row`).
      const cards = page.locator(".collection-row:visible")
      await expect(cards.first()).toBeVisible({ timeout: 20_000 })
      expect(await cards.count()).toBeGreaterThan(0)
    })
  }
)
