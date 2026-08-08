import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The shelf that reaches past the local catalog. `boot` stubs the search
// service with two hits, so what is checked is the shelf itself: the same tile
// the personal library is made of, a chevron into the full set, and a plus that
// a free account cannot use.
test(qase(167, caseTitle(167)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  const shelfTiles = page.locator(".carousel-cell .track-tile")

  await step(page, 167, 0, async () => {
    // One tile per hit, the library's own tile — not a shape of its own.
    await expect(shelfTiles.first()).toBeVisible({ timeout: 20_000 })
    await expect(shelfTiles).toHaveCount(2)
    await expect(shelfTiles.first()).toContainText("A lecture published as video")
    // Nothing added yet, so every corner is an offer to add.
    await expect(shelfTiles.first().locator("button.add")).toBeVisible()
  })

  await step(page, 167, 1, async () => {
    // The chevron opens the full set on its own page, carrying the query.
    await page.locator(".lane .section-more").first().click()
    await page.waitForURL("**/tabs/search/web?q=*", { timeout: 15_000 })
    await expect(page.locator(".grid .track-tile").first()).toBeVisible({ timeout: 20_000 })
    await page.goBack()
  })

  await step(page, 167, 2, async () => {
    // Adding is Pro. The e2e build boots non-Pro, so the plus is an entry to
    // the paywall and not to an ingest.
    await expect(shelfTiles.first()).toBeVisible({ timeout: 20_000 })
    await shelfTiles.first().locator("button.add").click()
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 15_000 })
  })
})
