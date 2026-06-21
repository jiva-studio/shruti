import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { interceptContent, preseedUserDb, preseedNonPro } from "../../support/bootstrap.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * First-launch onboarding (Qase 165). Deliberately does NOT seed
 * onboarding.completed, and uses a CLEAN user DB (no listening history) so the
 * first-launch gate — unset flag AND no prior sessions — shows the flow; the
 * default `preseed` fixture has history and would be treated as an established
 * user (see Qase 166). The carousel renders all slides at once (translated
 * horizontally), so we never assert on off-screen slide visibility — we drive
 * via the always-present footer primary + top-right Skip, touching a slide's
 * own controls only once it's the active page.
 */
test(qase(165, caseTitle(165)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedUserDb(page, "en", "clean")
  await preseedNonPro(page)

  const primary = page.getByTestId("onboarding-primary")

  await step(page, 165, 0, async () => {
    await page.goto("/")
    // Onboarding shows immediately — no Welcome/loading splash, no tab bar.
    await expect(primary).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/onboarding/)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
    await expect(primary).toHaveText(/get started/i)
  })

  await step(page, 165, 1, async () => {
    await primary.click() // Welcome → Topics
    await primary.click() // Topics → Daily wisdom
    // Enable daily wisdom via the morning preset (radio group: off / morning /
    // afternoon / evening), clickable once the slide is active.
    await page.getByTestId("onboarding-wisdom-morning").click()
  })

  await step(page, 165, 2, async () => {
    await primary.click() // Daily wisdom → Value moment
    await primary.click() // Value moment → Paywall
    // On the paywall the generic primary is hidden; finish via Skip ("Later").
    await expect(primary).toHaveCount(0)
    await page.getByTestId("onboarding-skip").click()
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.locator("ion-tab-bar")).toBeVisible()
  })

  await step(page, 165, 3, async () => {
    await page.goto("/")
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
  })
})
