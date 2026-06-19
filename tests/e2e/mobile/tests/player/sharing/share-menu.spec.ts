import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(65, caseTitle(65)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { pro: true })
  await openLibrary(page)

  await step(page, 65, 0, async () => {
    await openTrackSheet(page, trackRows(page).first())
  })

  await step(page, 65, 1, async () => {
    await trackSheet(page).locator(".share-btn").click()

    // The dev/web build is treated as subscribed, so Share opens the export action
    // sheet (PDF / text / audio) rather than the paywall. Rendering the PDF itself
    // is server-side (a @live concern) — here we assert the entry point exists.
    const sheet = page.locator("ion-action-sheet")
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    await expect(sheet.getByRole("button", { name: /pdf/i })).toBeVisible()
  })
})
