import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(147, caseTitle(147)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  const sheet = trackSheet(page)
  await step(page, 147, 0, async () => {
    await openTrackSheet(page, trackRows(page).first())

    // The card shows a non-empty title and the two primary actions.
    await expect(sheet.locator(".sheet-title")).not.toHaveText("")
    await expect(sheet.locator(".add-btn")).toBeVisible()
    await expect(sheet.locator(".share-btn")).toBeVisible()
  })

  await step(page, 147, 1, async () => {
    // It dismisses cleanly via the close button.
    await sheet.locator(".close-button").click()
    await expect(sheet).toBeHidden()
  })
})
