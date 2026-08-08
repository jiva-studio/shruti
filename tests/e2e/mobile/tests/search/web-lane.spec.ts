import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The lane that reaches past the local catalog. `boot` stubs the search service
// with exactly two hits — a YouTube address and a direct mp3 — because the two
// shapes are the thing being checked and they are chosen by the address, not by
// a field the service sends.
test(qase(167, caseTitle(167)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  const carouselCards = page.locator(".carousel-cell .addable")
  const plainRows = page.locator(".web-row")

  await step(page, 167, 0, async () => {
    // Video-hosted: a poster card in the carousel, showing the cover built from
    // the video id rather than anything the index stored.
    await expect(carouselCards.first()).toBeVisible({ timeout: 20_000 })
    await expect(carouselCards.first().locator("img.cover")).toHaveAttribute(
      "src",
      /i\.ytimg\.com\/vi\/[\w-]{11}\//
    )

    // File-hosted: no poster to show, so it is a row instead.
    await expect(plainRows.first()).toBeVisible({ timeout: 20_000 })
    await expect(plainRows.first()).toContainText("A lecture published as a file")

    // One of each, and the file-hosted one did NOT end up in the carousel.
    await expect(carouselCards).toHaveCount(1)
    await expect(plainRows).toHaveCount(1)
  })

  await step(page, 167, 1, async () => {
    // Adding an external lecture is Pro. The e2e build boots non-Pro, so the
    // control is an entry to the paywall and not to an ingest.
    await carouselCards.first().locator("button").first().click()
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 15_000 })
  })
})
