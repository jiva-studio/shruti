import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Settings and the Library landing each hold their own Smart Library binding,
 * and Ionic keeps both tab pages mounted for the app's lifetime. When the
 * binding was a snapshot hydrated once, whichever screen was visited first
 * showed stale values and its next edit wrote its whole stale copy back —
 * erasing the dimensions the other screen had persisted (#1853). The filters at
 * stake decide what the device downloads, so the loss was silent.
 *
 * Both screens are visited before anything is set, so both bindings are alive
 * for the whole journey — that is the condition the bug needs.
 */

const openModal = (page: Page, cls: string): Locator => page.locator(`ion-modal.${cls}.show-modal`)

const sheet = (page: Page): Locator => openModal(page, "filters-sheet")
const dialog = (page: Page): Locator => openModal(page, "smart-library-dialog")

const okButton = (scope: Locator) => scope.locator("ion-button", { hasText: /^Ok$/ })
const filterRow = (d: Locator) => d.locator("ion-item", { hasText: "Filter" }).first()

async function openFromSettings(page: Page): Promise<Locator> {
  await gotoTab(page, "settings")
  const entry = page.locator('[data-testid="settings-smart-library"]')
  await entry.scrollIntoViewIfNeeded()
  await entry.click()
  await expect(dialog(page)).toBeVisible({ timeout: 10_000 })
  return dialog(page)
}

async function openFromLibrary(page: Page): Promise<Locator> {
  await gotoTab(page, "search")
  const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
  await banner.scrollIntoViewIfNeeded()
  await banner.click()
  await expect(dialog(page)).toBeVisible({ timeout: 10_000 })
  return dialog(page)
}

/** Tick the first item of a facet and return its title, then unwind the sheet. */
async function pickFirst(page: Page, facet: string): Promise<string> {
  await filterRow(dialog(page)).click()
  const s = sheet(page)
  await expect(s).toBeVisible({ timeout: 10_000 })
  await s.locator("ion-item", { hasText: facet }).first().click()
  const checkbox = s.locator("ion-checkbox").first()
  await expect(checkbox).toBeVisible({ timeout: 10_000 })
  const title = ((await checkbox.textContent()) ?? "").trim()
  expect(title.length).toBeGreaterThan(0)
  await checkbox.click()
  await expect(checkbox).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
  await okButton(s).click() // back to the facet list
  await okButton(s).click() // dismiss the sheet
  await expect(sheet(page)).toBeHidden({ timeout: 10_000 })
  return title
}

/** Ionic teleports modals to the app root, so they outlive a tab switch. */
async function closeDialog(page: Page): Promise<void> {
  await okButton(dialog(page)).first().click()
  await expect(dialog(page)).toBeHidden({ timeout: 10_000 })
}

const TAGS = { tag: ["@offline", "@library", "@settings"] }

test(qase(440, caseTitle(440)), TAGS, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })

  let topicTitle = ""
  let authorTitle = ""

  await step(page, 440, 0, async (capture) => {
    // Library first: its binding is the one that used to go stale.
    await gotoTab(page, "search")
    await page
      .locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
      .waitFor({ state: "visible", timeout: 30_000 })

    const d = await openFromSettings(page)
    const enable = d.locator("ion-toggle").first()
    if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
    await expect(filterRow(d)).toContainText("All lectures", { timeout: 10_000 })

    topicTitle = await pickFirst(page, "Topics")
    await expect(filterRow(d)).toContainText(topicTitle, { timeout: 10_000 })
    await capture()
    await closeDialog(page)
  })

  await step(page, 440, 1, async () => {
    const d = await openFromLibrary(page)
    // The whole bug in one assertion: this row read "All lectures" because the
    // Library's binding had hydrated from an empty store and never re-read it.
    await expect(filterRow(d)).toContainText(topicTitle, { timeout: 10_000 })
  })

  await step(page, 440, 2, async () => {
    authorTitle = await pickFirst(page, "Authors")
    await expect(filterRow(dialog(page))).toContainText(authorTitle, { timeout: 10_000 })
    await closeDialog(page)

    const d = await openFromSettings(page)
    // Editing authors from the Library used to write all ten dimensions from
    // that screen's stale snapshot, taking the topic with it.
    await expect(filterRow(d)).toContainText(authorTitle, { timeout: 10_000 })
    await expect(filterRow(d)).toContainText(topicTitle, { timeout: 10_000 })
  })
})
