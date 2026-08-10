import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Where a lecture comes from: it is part of that cycle, and here is the way
 * back to it. A talk can sit in more than one cycle, so the sheet shows a list
 * rather than a field.
 *
 * The ordinal is the load-bearing assertion — the catalog stores `position`
 * 0-based and `getCollectionsOfTrack` converts it with a COUNT subquery, so an
 * off-by-one there is visible here and on no other screen.
 *
 * The row-level ordinal chip is not asserted here because it does not belong
 * here: it is fed from the provenance a whole-collection add records, so it
 * appears on the Home queue (Qase 40), not on the collection page — where the
 * list order already states the same thing.
 */
test(qase(179, caseTitle(179)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })

  let collectionName = ""

  await step(page, 179, 0, async () => {
    // Open the first collection from the discovery carousel.
    await gotoTab(page, "search")
    const card = page.locator(".carousel-section .collection-card").first()
    await card.waitFor({ state: "visible", timeout: 20_000 })
    collectionName = (await card.innerText()).trim().split("\n")[0]!.trim()
    await card.click()
    await page.waitForURL("**/search/collection/**", { timeout: 10_000 })
    // Ionic keeps the page we came from mounted through the transition, so a
    // row read too early belongs to the screen sliding away.
    await page.waitForTimeout(800)
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 179, 1, async (capture) => {
    // The sheet names the cycle and the lecture's place in it.
    await openTrackSheet(page, trackRows(page).first())
    const partOf = trackSheet(page).locator(".part-of").first()
    await expect(partOf).toBeVisible({ timeout: 10_000 })
    await expect(partOf.locator(".part-of-place")).toHaveText(/Lecture 1 of \d+/)
    if (collectionName) await expect(partOf.locator(".part-of-name")).toHaveText(collectionName)
    await capture()
  })

  await step(page, 179, 2, async () => {
    // And it is the way back to the cycle.
    await trackSheet(page).locator(".part-of").first().click()
    await page.waitForURL("**/collection/**", { timeout: 10_000 })
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
  })
})
