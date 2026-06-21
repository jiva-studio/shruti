import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * First-launch resilience (post-Welcome-removal). The Welcome screen + its
 * "download failed → Retry" error UI are gone: the content DB ships bundled and
 * the bootstrap runs HEADLESS behind the native splash, treating a content-DB
 * open failure as non-fatal (logged, not a blocking error page).
 *
 * So the guarantee is no longer "Retry button recovers" but "a failed content
 * DB never bricks the launch on an infinite splash" — a brand-new user still
 * reaches the onboarding carousel and can proceed.
 *
 * We force the failure deterministically by aborting every content-DB request.
 */
test(qase(144, caseTitle(144)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  // Abort the content-DB download so it can never open — exercises the headless
  // bootstrap's non-fatal failure path.
  await page.route("**/public/db/lectorium.*.db", (route) => void route.abort("failed"))
  await preseedUserDb(page, "en", "clean") // no listening history → first-launch path
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await step(page, 144, 0, async () => {
    await page.goto("/?locale=en")
    // No infinite "Downloading…" splash and no dead end: a fresh user still
    // lands on the onboarding carousel (its Welcome slide needs no content DB).
    await expect(page.getByTestId("onboarding-primary")).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/onboarding/)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
  })
})
