import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Tapping the build-info line several times unlocks the hidden Debug section
// (View logs / Clear cache). The unlocker needs 5 taps (kit default).
test(
  qase(122, caseTitle(122)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "settings")

    const buildInfo = page.locator(".kit-build-info")
    await step(page, 122, 0, async () => {
      await buildInfo.scrollIntoViewIfNeeded()
      await expect(buildInfo).toBeVisible({ timeout: 10_000 })
      // The version line is shown.
      await expect(page.locator(".kit-build-info-version")).toBeVisible()
    })

    await step(page, 122, 1, async () => {
      // Tap to cross the unlock threshold (default 5; tap a few extra to be safe).
      for (let i = 0; i < 7; i++) await buildInfo.click()

      // The Debug section appears with its "View logs" action.
      await expect(page.locator("ion-item", { hasText: "View logs" })).toBeVisible({ timeout: 10_000 })
    })
  }
)
