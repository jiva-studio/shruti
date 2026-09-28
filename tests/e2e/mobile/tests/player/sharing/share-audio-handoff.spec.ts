import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Library → Share → Audio hands a long transfer off to the background.
 *
 * The modal it presents is created without `backdropDismiss` and without a
 * cancel, and behind it runs a full-lecture download. Without the handoff, a
 * transfer that stalls without failing would hold both the UI and the app-wide
 * share slot until a force-quit.
 *
 * Determinism comes from a gate, not from timing: the audio route never
 * answers, so the transfer is guaranteed to still be running when the handoff
 * is due. What is asserted is the handoff itself — the modal leaves on its own
 * and the tab bar picks up the story — not the 45-second stall abort, which is
 * covered by the unit suite.
 */
const TAB_SPINNER = ".notes-tab-spinner"

test(qase(551, caseTitle(551)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })

  // Registered after boot so it wins over the silent-MP3 stub: the handler
  // never settles the request, which is the parked-transfer shape.
  await page.route("**/public/tracks/*/audio/*", () => {})

  await step(page, 551, 0, async () => {
    await openLibrary(page)
    await openTrackSheet(page, trackRows(page).first())
    await trackSheet(page).locator(".share-btn").click()

    const sheet = page.locator("ion-action-sheet")
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    await sheet.getByRole("button", { name: /^audio$/i }).click()

    await expect(page.locator("ion-loading")).toBeVisible({ timeout: 15_000 })
  })

  await step(page, 551, 1, async () => {
    // The 3-second handoff: the UI comes back without the user doing anything,
    // and the held slot shows its cause in the tab bar.
    await expect(page.locator("ion-loading")).toBeHidden({ timeout: 30_000 })
    await expect(page.locator("ion-toast")).toContainText(/background/i, { timeout: 15_000 })
    await expect(page.locator(TAB_SPINNER)).toBeVisible({ timeout: 15_000 })
  })
})
