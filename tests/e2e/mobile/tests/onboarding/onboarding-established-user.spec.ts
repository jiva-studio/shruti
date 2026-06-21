import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { interceptContent, preseedUserDb, preseedNonPro } from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The skip gate (Qase 166). A user upgrading INTO the build that introduced
 * onboarding has prior listening history but no onboarding.completed flag. The
 * gate treats them as established and routes straight to Home, stamping the flag
 * so the history probe runs at most once.
 *
 * We deliberately do NOT use boot() — it seeds onboarding.completed itself, which
 * would mask the gate. We seed the DEFAULT `preseed` fixture (which carries
 * listening history) and leave the flag unset.
 */
test(qase(166, caseTitle(166)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedUserDb(page, "en") // default fixture: has listening history
  await preseedNonPro(page)

  await step(page, 166, 0, async () => {
    await page.goto("/")
    // Established user → straight to Home, onboarding never shown.
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.locator("ion-tab-bar")).toBeVisible()
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
  })

  await step(page, 166, 1, async () => {
    await page.goto("/")
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
  })
})
