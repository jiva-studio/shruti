import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, searchInput, trackRows } from "../../support/nav.js"
import { installDiscoveryMock } from "../../support/discovery-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * One field, three pages, one searcher.
 *
 * The docked field is shared by the library tab and the two pages it pushes on
 * top of itself, and Ionic keeps the ones underneath mounted — so every pause in
 * typing used to be searched by all of them at once, with only the top one
 * showing an answer. What is checked here is the arithmetic of that: how many
 * requests one pause makes, and that the page underneath still catches up with
 * words typed while it was covered.
 */

// How long a pause has to be to be certain nothing further is owed: the typing
// debounces are 200 ms (library) and 400 ms (archives).
const AFTER_THE_DEBOUNCES = 2_000

test(qase(332, caseTitle(332)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  const requests: unknown[] = []

  await boot(page, "en", { userDb: "clean" })
  await installDiscoveryMock(page, { onRequest: (body) => requests.push(body) })
  await openLibrary(page)

  await step(page, 332, 0, async () => {
    await page.locator(".lane .section-more").first().click()
    await page.waitForURL("**/tabs/search/web?q=*", { timeout: 15_000 })
    await expect(page.locator(".grid .track-tile").first()).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 332, 1, async () => {
    // Count only what the new words cost — arriving here is a search of its own.
    await page.waitForTimeout(AFTER_THE_DEBOUNCES)
    requests.length = 0

    await searchInput(page).fill("gita")
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1)
    // And still one once every debounce has had its chance to fire.
    await page.waitForTimeout(AFTER_THE_DEBOUNCES)
    expect(requests).toHaveLength(1)
  })
})

test(qase(333, caseTitle(333)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  await step(page, 333, 0, async () => {
    await page.locator(".lane .section-more").first().click()
    await page.waitForURL("**/tabs/search/web?q=*", { timeout: 15_000 })
    await expect(page.locator(".grid .track-tile").first()).toBeVisible({ timeout: 20_000 })
    // The same field, edited from up here, to something the catalog cannot match.
    await searchInput(page).fill("zzzqqxnomatch")
    await page.waitForTimeout(AFTER_THE_DEBOUNCES)
  })

  await step(page, 333, 1, async () => {
    await page.goBack()
    await page.waitForURL("**/tabs/search", { timeout: 15_000 })
    // The list is for the words in the field, not the ones that were in it when
    // the page was covered.
    await expect(page.locator(".no-results")).toBeVisible({ timeout: 20_000 })
    await expect(trackRows(page)).toHaveCount(0)
  })
})
