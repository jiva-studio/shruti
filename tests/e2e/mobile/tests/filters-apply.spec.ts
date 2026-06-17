import { test, expect, type Locator, type Page } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { openLibrary, trackRows, trackTitles } from "../support/nav.js"

/**
 * Library filters — apply / sort / reset (live-apply bottom sheet).
 *
 * `boot()` pins the library to source `source_dsicuBsFvinZ` with
 * `sort:byReference`, so the list is populated + deterministic and the filters
 * badge is already active. The sheet (`ion-modal.filters-sheet`) applies every
 * toggle live; OK ("Ok") just dismisses, Reset ("Reset") clears every
 * dimension. The list view is a drill-in `IonList`: one `IonItem` per facet,
 * its label in an `<h2>`. Drilling in shows the picker — multi facets render
 * `ion-checkbox` rows, single facets render `button` rows with a check icon.
 */

/* ----------------------------- local helpers ----------------------------- */

/** The presented filters overlay (an Ionic transition can leave a stale,
 *  `.overlay-hidden` modal from a previous SearchView in the DOM). */
function sheet(page: Page): Locator {
  return page.locator("ion-modal.filters-sheet.show-modal")
}

/** Open the filters sheet from the library header and wait for it to present. */
async function openSheet(page: Page): Promise<Locator> {
  await page.locator(".search-row-filter-button").click()
  const s = sheet(page)
  await expect(s).toBeVisible({ timeout: 10_000 })
  // Let the modal-present web-animation settle before reading/clicking rows.
  await page.waitForTimeout(400)
  return s
}

/** Drill into a facet by its (English) section title in the list view. */
async function enterFacet(s: Locator, title: string): Promise<void> {
  await s.locator("ion-item", { hasText: title }).first().click()
  // Settle the drill-in slide transition.
  await s.page().waitForTimeout(300)
}

/** The toolbar OK button. On a sub-picker it returns to the list
 *  (onPrimary → leaveSection); on the root list view it dismisses the sheet. */
function okButton(s: Locator): Locator {
  return s.locator("ion-button", { hasText: /^Ok$/ })
}

/** The toolbar Reset button (only rendered on the root list view). */
function resetButton(s: Locator): Locator {
  return s.locator("ion-button", { hasText: /^Reset$/ })
}

/** Return from a facet sub-picker to the root list view. The toolbar OK acts as
 *  "done with this dimension" while a sub-picker is shown. */
async function backToList(s: Locator): Promise<void> {
  await okButton(s).click()
  // Reset only renders on the root view; its presence confirms we're back.
  await expect(resetButton(s)).toBeVisible({ timeout: 10_000 })
}

/** Dismiss the sheet from the root list view and wait for it to leave the DOM. */
async function closeSheet(page: Page, s: Locator): Promise<void> {
  await okButton(s).click()
  await expect(sheet(page)).toBeHidden({ timeout: 10_000 })
}

/* -------------------------------- tests ---------------------------------- */

test(
  "library · filter by source changes the catalog",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    // The seeded source has hundreds of tracks, so the first page (PAGE_SIZE=50)
    // is always full — the visible ROW COUNT can't observe a source change.
    // Compare the visible catalog itself instead: swap to a different source and
    // assert the page of titles is a genuinely different set.
    const baseline = await trackTitles(page)
    expect(baseline.length).toBeGreaterThan(0)

    const s = await openSheet(page)
    await enterFacet(s, "Sources")

    const checkboxes = s.locator("ion-checkbox")
    await expect(checkboxes.first()).toBeVisible({ timeout: 10_000 })
    const total = await checkboxes.count()

    // Drop the seeded source and pick a different one, so the catalog becomes a
    // disjoint set (no overlap) — a robust, deterministic change signal.
    let enabledOne = false
    for (let i = 0; i < total; i++) {
      const cb = checkboxes.nth(i)
      const checked = await cb.evaluate(
        (el) => (el as HTMLElement & { checked?: boolean }).checked === true
      )
      if (checked) {
        await cb.click() // uncheck the seeded source
      } else if (!enabledOne) {
        await cb.click() // enable exactly one different source
        enabledOne = true
      }
    }
    expect(enabledOne, "expected a different source to enable").toBe(true)

    await backToList(s)
    await closeSheet(page, s)

    // Live re-query: the visible title set must differ from the seeded baseline.
    await expect
      .poll(
        async () => {
          const next = await trackTitles(page)
          return next.length > 0 && next.join("") !== baseline.join("")
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  }
)

test(
  "library · sort byDateAsc reorders the list",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    const byReference = await trackTitles(page)
    expect(byReference.length).toBeGreaterThan(1)

    const s = await openSheet(page)
    await enterFacet(s, "Sort")

    // Sort is single-select: button rows. Choose oldest-first.
    await s.locator("ion-item", { hasText: "Date (oldest first)" }).first().click()
    await page.waitForTimeout(200)
    await backToList(s)
    await closeSheet(page, s)

    // Live re-sort: assert the order differs from the byReference capture.
    await expect
      .poll(
        async () => {
          const next = await trackTitles(page)
          return next.length === byReference.length && next.join("") !== byReference.join("")
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  }
)

test(
  "library · reset clears the filters and disables itself",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    const s = await openSheet(page)

    // boot() seeds a pinned source, so Reset is enabled from the start; modify
    // further (enable a second source) so we exercise a genuinely dirty state.
    await enterFacet(s, "Sources")
    const checkboxes = s.locator("ion-checkbox")
    await expect(checkboxes.first()).toBeVisible({ timeout: 10_000 })
    const total = await checkboxes.count()
    for (let i = 0; i < total; i++) {
      const cb = checkboxes.nth(i)
      const checked = await cb.evaluate(
        (el) => (el as HTMLElement & { checked?: boolean }).checked === true
      )
      if (!checked) {
        await cb.click()
        break
      }
    }
    await backToList(s)

    // Reset is enabled in the dirty state. A disabled IonButton carries the
    // `button-disabled` class (and `aria-disabled="true"`); an enabled one
    // doesn't. Assert against the class (a custom element isn't a native form
    // control, so `toBeDisabled`/`aria-disabled="false"` are unreliable here).
    await expect(resetButton(s)).not.toHaveClass(/\bbutton-disabled\b/)

    // The Sources facet summary is NOT the placeholder "Any" while a source is set.
    const sourcesSummary = s
      .locator("ion-item", { hasText: "Sources" })
      .first()
      .locator(".section-summary")
    await expect(sourcesSummary).not.toHaveText("Any")

    await resetButton(s).click()

    // After reset every facet summary collapses to "Any", the active badge
    // clears (activeFilterCount → 0), and Reset disables itself.
    await expect(sourcesSummary).toHaveText("Any", { timeout: 10_000 })
    await expect(resetButton(s)).toHaveClass(/\bbutton-disabled\b/, { timeout: 10_000 })
    await expect(page.locator(".search-row-filter-button")).not.toHaveClass(/\bis-active\b/)

    await closeSheet(page, s)
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
  }
)
