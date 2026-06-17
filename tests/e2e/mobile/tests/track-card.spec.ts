import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../support/nav.js"

test("library · tapping a track opens its card", { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await openTrackSheet(page, trackRows(page).first())

  const sheet = trackSheet(page)
  // The card shows a non-empty title and the two primary actions.
  await expect(sheet.locator(".sheet-title")).not.toHaveText("")
  await expect(sheet.locator(".add-btn")).toBeVisible()
  await expect(sheet.locator(".share-btn")).toBeVisible()

  // It dismisses cleanly via the close button.
  await sheet.locator(".close-button").click()
  await expect(sheet).toBeHidden()
})
