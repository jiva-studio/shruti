import { test, expect, type Locator, type Page } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openLibrary, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Track Info Layout is Pro, and it is the Pro feature whose effect is easiest
 * to see: the metadata line under every track title is rendered from a config
 * the app only honours for a subscriber (`useTrackMetadataFields`), so the two
 * tiers produce visibly different lists from the same catalog.
 *
 * That is also what makes this pair the check on the tier seam itself. Case 200
 * only passes if `boot({ pro: true })` really produced a subscriber, and case
 * 201 only passes if the default boot really produced a free user — and they
 * assert it on the same surface, so neither can be satisfied by the other's
 * app. Before the seam existed, case 200 ran as a free user under
 * `E2E_USE_BUNDLE=1` and never got past the paywall (#1633).
 */

const settingsRow = (page: Page): Locator => page.locator('[data-testid="settings-track-info"]')
const dialog = (page: Page): Locator => page.locator("ion-modal.track-info-dialog")

/** The reference chip inside a row's metadata line (its own class, so it is
 *  distinguishable from the date / duration / location segments beside it). */
const lineReference = (row: Locator): Locator => row.locator(".details .reference")

test(qase(202, caseTitle(200)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })

  let reference = ""

  await step(page, 202, 0, async () => {
    await openLibrary(page)
    const first = trackRows(page).first()
    await expect(lineReference(first)).toBeVisible({ timeout: 20_000 })
    reference = ((await lineReference(first).first().innerText()) ?? "").trim()
    expect(reference.length).toBeGreaterThan(0)
  })

  await step(page, 202, 1, async (capture) => {
    await gotoTab(page, "settings")
    await settingsRow(page).scrollIntoViewIfNeeded()
    await settingsRow(page).click()
    // As a subscriber the row opens the editor; a free user gets the paywall
    // (case 201), which is the whole difference this pair is checking.
    await expect(dialog(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(".subscription-page")).toHaveCount(0)
    await capture()
  })

  await step(page, 202, 2, async () => {
    const referenceToggle = dialog(page)
      .locator("ion-item", { hasText: "Reference" })
      .locator("ion-toggle")
    await expect(referenceToggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await referenceToggle.click()
    await expect(referenceToggle).toHaveAttribute("aria-checked", "false", { timeout: 10_000 })

    await dialog(page).getByRole("button", { name: /^ok$/i }).click()
    await expect(dialog(page)).toBeHidden({ timeout: 10_000 })
  })

  await step(page, 202, 3, async () => {
    await gotoTab(page, "search")
    const first = trackRows(page).first()
    // The reference is gone from the line, and the line itself is still there —
    // the field was dropped, not the whole row layout.
    await expect(lineReference(first)).toHaveCount(0, { timeout: 20_000 })
    await expect(first.locator(".details")).toBeVisible()
    await expect(first.locator(".details")).not.toContainText(reference)
  })
})

test(qase(202, caseTitle(201)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })

  await step(page, 202, 0, async (capture) => {
    await gotoTab(page, "settings")
    await settingsRow(page).scrollIntoViewIfNeeded()
    await settingsRow(page).click()
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    await expect(dialog(page)).toBeHidden()
    await capture()
  })

  await step(page, 202, 1, async () => {
    await page.goBack()
    await openLibrary(page)
    // Nothing was configurable, so the list keeps the default layout — the
    // reference sits in the line under the title.
    await expect(lineReference(trackRows(page).first())).toBeVisible({ timeout: 20_000 })
  })
})
