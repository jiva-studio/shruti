import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The Smart Library filter sheet writes to its own persisted store, so a facet
 * it forgets to write is one the user sets, sees confirmed in the summary, and
 * loses on the next launch — while the download loop keeps queueing from the
 * unfiltered library (#1585). A restart is the only way to tell the two apart.
 */
function sheet(page: Page): Locator {
  return page.locator("ion-modal.filters-sheet.show-modal")
}

const okButton = (s: Locator) => s.locator("ion-button", { hasText: /^Ok$/ })

async function openDialog(page: Page): Promise<Locator> {
  const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
  await banner.scrollIntoViewIfNeeded()
  await banner.click()
  const dialog = page.locator("ion-modal.smart-library-dialog")
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

const filterRow = (d: Locator) => d.locator("ion-item", { hasText: "Filter" }).first()

test(qase(196, caseTitle(192)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })
  await gotoTab(page, "search")

  let topicTitle = ""

  await step(page, 196, 0, async (capture) => {
    const dialog = await openDialog(page)
    const enable = dialog.locator("ion-toggle").first()
    if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
    await expect(filterRow(dialog)).toContainText("All lectures", { timeout: 10_000 })

    await filterRow(dialog).click()
    const s = sheet(page)
    await expect(s).toBeVisible({ timeout: 10_000 })
    await s.locator("ion-item", { hasText: "Topics" }).first().click()
    const checkbox = s.locator("ion-checkbox").first()
    await expect(checkbox).toBeVisible({ timeout: 10_000 })
    topicTitle = ((await checkbox.textContent()) ?? "").trim()
    expect(topicTitle.length).toBeGreaterThan(0)
    await checkbox.click()
    await expect(checkbox).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await capture()

    await okButton(s).click() // back to the facet list
    await okButton(s).click() // dismiss the sheet
    await expect(sheet(page)).toBeHidden({ timeout: 10_000 })
    await expect(filterRow(dialog)).toContainText(topicTitle, { timeout: 10_000 })
  })

  await step(page, 196, 1, async () => {
    // Full re-hydration from what was actually persisted.
    await page.reload()
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    await gotoTab(page, "search")
  })

  await step(page, 196, 2, async () => {
    const dialog = await openDialog(page)
    await expect(filterRow(dialog)).toContainText(topicTitle, { timeout: 10_000 })

    // …and the sheet still shows it checked, not an empty facet behind a
    // summary read from memory.
    await filterRow(dialog).click()
    const s = sheet(page)
    await expect(s).toBeVisible({ timeout: 10_000 })
    await expect(
      s.locator("ion-item", { hasText: "Topics" }).first().locator(".count-pill")
    ).toHaveText("1", { timeout: 10_000 })
  })
})
