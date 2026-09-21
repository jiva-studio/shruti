import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import {
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
  trackTitles,
} from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Case 26 proves a filter re-queries the list; case 29 proves a row can be
// added. What neither covers is the seam: the rows a re-query produces are
// rebuilt, and a row that lost its handler looks identical to one that kept it.

function sheet(page: Page): Locator {
  return page.locator("ion-modal.filters-sheet.show-modal")
}

test(qase(604, caseTitle(604)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  let title = ""

  await step(page, 604, 0, async () => {
    await openLibrary(page, "1")
    const before = await trackTitles(page)
    expect(before.length).toBeGreaterThan(1)

    await page.locator(".filters-button").click()
    const s = sheet(page)
    await expect(s).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await s.locator("ion-item", { hasText: "Sort" }).first().click()
    await page.waitForTimeout(300)
    await s.locator("ion-item", { hasText: "Date (newest first)" }).first().click()
    await page.waitForTimeout(200)
    await s.locator("ion-button", { hasText: /^Ok$/ }).click()
    await expect(s.locator("ion-button", { hasText: /^Reset$/ })).toBeVisible({ timeout: 10_000 })
    await s.locator("ion-button", { hasText: /^Ok$/ }).click()
    await expect(sheet(page)).toBeHidden({ timeout: 10_000 })

    await expect
      .poll(async () => (await trackTitles(page)).join("") !== before.join(""), { timeout: 15_000 })
      .toBe(true)
    await expect(page.locator(".filters-button")).toHaveClass(/\bis-active\b/, { timeout: 10_000 })
  })

  await step(page, 604, 1, async () => {
    const rows = trackRows(page)
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    title = (await rows.first().locator(".title").innerText()).trim()

    await openTrackSheet(page, rows.first())
    const add = trackSheet(page).locator(".add-btn")
    await expect(add).not.toHaveClass(/button-disabled/)
    await add.click()
    await expect(trackSheet(page)).toBeHidden()

    const row = trackRows(page).filter({ hasText: title }).first()
    await expect(row.locator('[data-testid="track-state"]')).toHaveAttribute(
      "data-state",
      /added|downloading|completed/,
      { timeout: 15_000 }
    )
  })

  await step(page, 604, 2, async () => {
    await gotoTab(page, "home")
    await expect(playlistRows(page).filter({ hasText: title }).first()).toBeVisible({
      timeout: 20_000,
    })
  })
})
