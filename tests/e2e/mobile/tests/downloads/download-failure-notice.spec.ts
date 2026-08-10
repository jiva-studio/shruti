import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { qase } from "playwright-qase-reporter"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A failed download says so.
 *
 * Before it spoke up, the only sign was a red X on the row — a silent failure
 * for anyone not watching that row at that moment. The rule the notice follows
 * is that a background queue may be rate-limited but an explicit request never
 * is: a queue failing every job in airplane mode should be told once, and must
 * not be able to swallow the answer to something the user just pressed.
 *
 * Determinism comes from a gate, not from timing: the audio route aborts, so
 * every transfer is guaranteed to fail.
 */
const FAILURE_COPY = "Download failed. Check your internet connection and try again."

test(qase(186, caseTitle(186)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedOnboardingDone(page)
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await page.route("**/public/tracks/*/audio/*", (route) => void route.abort("failed"))

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

  const toast = page.locator("ion-toast")
  let row = trackRows(page).first()

  await step(page, 186, 0, async () => {
    // Add a lecture whose audio cannot be fetched.
    await openLibrary(page)
    row = trackRows(page).first()
    await openTrackSheet(page, row)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 186, 1, async () => {
    // The failure is told, not left to a red X nobody was looking at.
    await expect(toast).toContainText(FAILURE_COPY, { timeout: 30_000 })
    await expect(row.locator('[data-testid="track-state"]')).toHaveAttribute(
      "data-state",
      "failed",
      { timeout: 30_000 }
    )
  })

  await step(page, 186, 2, async () => {
    // Dismiss what is on screen so the next assertion cannot read a stale toast.
    await toast.first().evaluate((el: HTMLElement & { dismiss?: () => void }) => el.dismiss?.())
    await expect(toast).toHaveCount(0, { timeout: 20_000 })
  })

  await step(page, 186, 3, async () => {
    // A deliberate retry is answered immediately — the queue's own cooldown
    // must never suppress an answer the user is waiting for.
    await openTrackSheet(page, row)
    await trackSheet(page).locator(".add-btn").click()
    await expect(toast).toContainText(FAILURE_COPY, { timeout: 30_000 })
  })
})
