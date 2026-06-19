import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, trackRows, trackTitles } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Library filters — the whole live-apply journey in one case (case 26): pick a
 * Source and re-query, see the active-filter badge, change the Sort and re-order,
 * then Reset. The sheet (`ion-modal.filters-sheet`) applies live; OK ("Ok")
 * dismisses, Reset ("Reset") clears every dimension. `boot()` pins source
 * `source_dsicuBsFvinZ` with `sort:byReference`, so the list is populated and
 * deterministic and the badge is active from the start.
 *
 * Steps alternate "configure the sheet" (screenshotted via capture() while it is
 * open, since OK dismisses it) and "apply → observe the library", so the run
 * shows each filter that was set AND its effect.
 */

/** The presented filters overlay (an Ionic transition can leave a stale,
 *  `.overlay-hidden` modal from a previous SearchView in the DOM). */
function sheet(page: Page): Locator {
  return page.locator("ion-modal.filters-sheet.show-modal")
}

async function openSheet(page: Page): Promise<Locator> {
  await page.locator(".search-row-filter-button").click()
  const s = sheet(page)
  await expect(s).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400) // let the modal-present web-animation settle
  return s
}

/** Drill into a facet by its (English) section title in the list view. */
async function enterFacet(s: Locator, title: string): Promise<void> {
  await s.locator("ion-item", { hasText: title }).first().click()
  await s.page().waitForTimeout(300) // settle the drill-in slide
}

const okButton = (s: Locator) => s.locator("ion-button", { hasText: /^Ok$/ })
const resetButton = (s: Locator) => s.locator("ion-button", { hasText: /^Reset$/ })
const facetSummary = (s: Locator, facet: string) =>
  s.locator("ion-item", { hasText: facet }).first().locator(".section-summary")

/** Return from a facet sub-picker to the root list view (toolbar OK = "done"). */
async function backToList(s: Locator): Promise<void> {
  await okButton(s).click()
  await expect(resetButton(s)).toBeVisible({ timeout: 10_000 }) // Reset only on root
}

/** Dismiss the sheet from the root list view and wait for it to leave the DOM. */
async function closeSheet(page: Page, s: Locator): Promise<void> {
  await okButton(s).click()
  await expect(sheet(page)).toBeHidden({ timeout: 10_000 })
}

const filterBadge = (page: Page) => page.locator(".search-row-filter-button")

test(
  qase(26, caseTitle(26)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    let s!: Locator
    let baseline: string[] = []
    let byReference: string[] = []

    await step(page, 26, 0, async (capture) => {
      // Swap the pinned source for a different one — a disjoint catalog so the
      // re-query is observable as a genuinely different page of titles.
      baseline = await trackTitles(page)
      expect(baseline.length).toBeGreaterThan(0)

      s = await openSheet(page)
      await enterFacet(s, "Sources")
      const checkboxes = s.locator("ion-checkbox")
      await expect(checkboxes.first()).toBeVisible({ timeout: 10_000 })
      const total = await checkboxes.count()
      let enabledOne = false
      for (let i = 0; i < total; i++) {
        const cb = checkboxes.nth(i)
        const checked = await cb.evaluate(
          (el) => (el as HTMLElement & { checked?: boolean }).checked === true
        )
        if (checked) await cb.click()
        else if (!enabledOne) {
          await cb.click()
          enabledOne = true
        }
      }
      expect(enabledOne, "expected a different source to enable").toBe(true)
      await backToList(s)
      // Screenshot the sheet with the new Sources selection before it closes.
      await capture()
    })

    await step(page, 26, 1, async () => {
      // Apply: the library re-queries to a disjoint set, and the header
      // active-filter badge stays highlighted (a pinned source is a real filter).
      await closeSheet(page, s)
      await expect
        .poll(
          async () => {
            const next = await trackTitles(page)
            return next.length > 0 && next.join("") !== baseline.join("")
          },
          { timeout: 15_000 }
        )
        .toBe(true)
      await expect(filterBadge(page)).toHaveClass(/\bis-active\b/, { timeout: 10_000 })
    })

    await step(page, 26, 2, async (capture) => {
      // Change the Sort to oldest-first.
      byReference = await trackTitles(page)
      expect(byReference.length).toBeGreaterThan(1)
      s = await openSheet(page)
      await enterFacet(s, "Sort")
      await s.locator("ion-item", { hasText: "Date (oldest first)" }).first().click()
      await page.waitForTimeout(200)
      await backToList(s)
      // Wait until the Sort summary reflects the choice, THEN screenshot the sheet
      // — otherwise the frame can catch the pre-selection state.
      await expect(facetSummary(s, "Sort")).toContainText(/oldest/i, { timeout: 10_000 })
      await capture()
    })

    await step(page, 26, 3, async () => {
      // Apply: the list re-orders live — the order differs from the by-reference one.
      await closeSheet(page, s)
      await expect
        .poll(
          async () => {
            const next = await trackTitles(page)
            return next.length === byReference.length && next.join("") !== byReference.join("")
          },
          { timeout: 15_000 }
        )
        .toBe(true)
    })

    await step(page, 26, 4, async () => {
      // Reset: every facet collapses to "Any", the active badge clears, and Reset
      // disables itself. The sheet stays open, so the auto-screenshot shows it.
      s = await openSheet(page)
      await expect(facetSummary(s, "Sources")).not.toHaveText("Any")
      await resetButton(s).click()
      await expect(facetSummary(s, "Sources")).toHaveText("Any", { timeout: 10_000 })
      await expect(resetButton(s)).toHaveClass(/\bbutton-disabled\b/, { timeout: 10_000 })
      await expect(filterBadge(page)).not.toHaveClass(/\bis-active\b/)
    })
  }
)
