import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

// A failed content-DB load must not hang the launch (bootstrap is headless, with
// no Welcome/Retry screen). It must not land on the onboarding carousel either,
// which is a dead end without a database: every one of its screens reads through
// `repositories()`, and its Finish replaces to /tabs/home, which the database
// guard bounces straight back to onboarding. The app shows the storage-error
// screen with the reason instead.
test(qase(144, caseTitle(144)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await page.route("**/public/db/shruti.*.db", (route) => void route.abort("failed"))
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await step(page, 144, 0, async () => {
    await page.goto("/?locale=en")
    await expect(page.getByTestId("storage-error")).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/storage-error/)
    await expect(page.getByTestId("storage-error-reason")).not.toBeEmpty()
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
  })
})
