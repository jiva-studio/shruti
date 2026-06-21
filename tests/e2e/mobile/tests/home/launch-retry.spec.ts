import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

// A failed content-DB load must not hang the launch (no Welcome/Retry screen
// anymore — bootstrap is headless): a fresh user still reaches onboarding.
test(qase(144, caseTitle(144)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await page.route("**/public/db/shruti.*.db", (route) => void route.abort("failed"))
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await step(page, 144, 0, async () => {
    await page.goto("/?locale=en")
    await expect(page.getByTestId("onboarding-primary")).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/onboarding/)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
  })
})
