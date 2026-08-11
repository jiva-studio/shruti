import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(65, caseTitle(65)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  await step(page, 65, 0, async () => {
    await openTrackSheet(page, trackRows(page).first())
  })

  await step(page, 65, 1, async () => {
    await trackSheet(page).locator(".share-btn").click()

    // Rendering the PDF itself is server-side (a @live concern) — here we assert
    // the export entry points exist. Labels come from i18n locales/en/search.ts
    // → search.share.*: "Transcript (PDF)", "Transcript (text)", "Audio". Audio
    // is enabled because the seeded track variant has the silent-MP3 stub. Match
    // by rendered i18n label, not index.
    const sheet = page.locator("ion-action-sheet")
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    const pdf = sheet.getByRole("button", { name: /transcript \(pdf\)/i })
    await expect(pdf).toBeVisible()
    await expect(sheet.getByRole("button", { name: /transcript \(text\)/i })).toBeVisible()
    await expect(sheet.getByRole("button", { name: /^audio$/i })).toBeVisible()

    // The sheet itself opens either way — the free user gets the same three
    // entries, with PDF marked as the locked one (`action-sheet-pro`) and
    // tapping it bouncing to the paywall. So the row list alone says nothing
    // about which tier this ran as; the absence of that marker is what makes
    // this a subscriber's sheet.
    await expect(pdf).not.toHaveClass(/action-sheet-pro/)
  })
})
