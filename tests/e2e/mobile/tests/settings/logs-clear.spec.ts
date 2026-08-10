import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The Logs dialog, past its entry row.
 *
 * Case 122 stops at seeing "View logs" in the unlocked Debug section, so the
 * dialog itself was never opened by anything. Its Clear button lives in an
 * `ion-footer`, which is exactly what a global rule meant for the track sheet
 * had been flattening — the button rendered, and swallowed every tap. A spec
 * that only looks would not have noticed.
 */
test(qase(181, caseTitle(181)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "settings")

  const dialog = page.locator("ion-modal.logs-dialog")

  await step(page, 181, 0, async () => {
    // Unlock Debug (the kit unlocker wants 5; tap a couple extra) and open it.
    const buildInfo = page.locator(".kit-build-info")
    await buildInfo.scrollIntoViewIfNeeded()
    for (let i = 0; i < 7; i++) await buildInfo.click()
    await page.locator("ion-item", { hasText: "View logs" }).click()
    await expect(dialog).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 181, 1, async (capture) => {
    // Booting the app writes log lines, so the footer — and its Clear — is there.
    const clear = dialog.locator("ion-footer ion-button", { hasText: "Clear" })
    await expect(clear).toBeVisible({ timeout: 10_000 })
    await capture()
    await clear.click()
  })

  await step(page, 181, 2, async () => {
    // The tap landed: the list is empty and the footer that held Clear is gone.
    await expect(dialog.locator(".logs-empty")).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator("ion-footer")).toHaveCount(0)
  })
})
