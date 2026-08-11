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
// anymore — bootstrap is headless). It used to land on the onboarding carousel,
// which was a dead end: every one of its screens reads through `repositories()`,
// and its Finish replaces to /tabs/home, which the database guard bounced
// straight back to onboarding (#1724). The app now says what happened instead.
test(qase(144, caseTitle(144)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await page.route("**/public/db/lectorium.*.db", (route) => void route.abort("failed"))
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
