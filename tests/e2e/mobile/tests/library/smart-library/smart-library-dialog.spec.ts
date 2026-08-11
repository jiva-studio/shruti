import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Smart Library dialog (Pro) in one case: a subscriber taps the banner to open
// the dialog, flips the Enable toggle on and back off, opens the Filter row →
// the search-filters sheet, and picks a Topic. The offline build is treated as
// subscribed (pro:true), so the banner opens the dialog (not the paywall).
//
// The case used to stop at "the sheet opened", which is why it could not fail
// on #1585: the Topics facet was offered, counted nowhere and saved nowhere, so
// the Reset button stayed disabled over a filter the user had visibly set.

/** The presented filters overlay (a dismissed one can linger in the DOM). */
function sheet(page: Page): Locator {
  return page.locator("ion-modal.filters-sheet.show-modal")
}

const okButton = (s: Locator) => s.locator("ion-button", { hasText: /^Ok$/ })
const resetButton = (s: Locator) => s.locator("ion-button", { hasText: /^Reset$/ })
const topicsRow = (s: Locator) => s.locator("ion-item", { hasText: "Topics" }).first()

test(
  qase(49, caseTitle(49)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en", { pro: true, userDb: "clean" })
    await gotoTab(page, "search")

    const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
    const dialog = page.locator("ion-modal.smart-library-dialog")
    const enable = dialog.locator("ion-toggle").first()
    let topicTitle = ""

    await step(page, 49, 0, async () => {
      // Tap the Smart Library banner → the dialog opens with the Enable toggle.
      await banner.scrollIntoViewIfNeeded()
      await expect(banner).toBeVisible({ timeout: 20_000 })
      await banner.click()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await expect(enable).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 49, 1, async () => {
      // The Enable toggle flips on and back off.
      const before = await enable.getAttribute("aria-checked")
      const after = before === "true" ? "false" : "true"
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", after)
      await enable.click()
      await expect(enable).toHaveAttribute("aria-checked", before ?? "false")
    })

    await step(page, 49, 2, async () => {
      // With the feature enabled, the Filter row opens the search-filters sheet.
      if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
      await dialog.locator("ion-item", { hasText: "Filter" }).first().click()
      await expect(sheet(page)).toBeVisible({ timeout: 10_000 })
      // Nothing is filtered yet, so there is nothing to reset.
      await expect(resetButton(sheet(page))).toHaveClass(/\bbutton-disabled\b/, { timeout: 10_000 })
    })

    await step(page, 49, 3, async (capture) => {
      // Pick a Topic — the facet that was offered but never counted (#1585).
      const s = sheet(page)
      await topicsRow(s).click()
      const checkbox = s.locator("ion-checkbox").first()
      await expect(checkbox).toBeVisible({ timeout: 10_000 })
      topicTitle = ((await checkbox.textContent()) ?? "").trim()
      expect(topicTitle.length).toBeGreaterThan(0)
      await checkbox.click()
      await expect(checkbox).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
      await capture()

      // Back to the facet list: the choice is counted, so Reset can undo it.
      await okButton(s).click()
      await expect(resetButton(s)).toBeVisible({ timeout: 10_000 })
      await expect(resetButton(s)).not.toHaveClass(/\bbutton-disabled\b/, { timeout: 10_000 })
      await expect(topicsRow(s).locator(".count-pill")).toHaveText("1", { timeout: 10_000 })
    })

    await step(page, 49, 4, async () => {
      // Close the sheet → the dialog's Filter row summarises the chosen topic.
      await okButton(sheet(page)).click()
      await expect(sheet(page)).toBeHidden({ timeout: 10_000 })
      const filterRow = dialog.locator("ion-item", { hasText: "Filter" }).first()
      await expect(filterRow).toContainText(topicTitle, { timeout: 10_000 })
    })
  }
)
