import { test, expect } from "../../support/test.js"
import { interceptContent, preseedUserDb, preseedNonPro } from "../../support/bootstrap.js"

/**
 * First-launch onboarding. Deliberately does NOT seed onboarding.completed, so
 * a fresh origin replays the flow. The carousel renders all slides at once
 * (translated horizontally), so we never assert on off-screen slide visibility —
 * we drive the flow via the always-present footer primary + top-right Skip, and
 * only touch a slide's own controls once it's the active page.
 */
test(
  "onboarding: first launch flows topics → wisdom → value → paywall → Home, and persists",
  { tag: ["@offline", "@onboarding"] },
  async ({ page }) => {
    await interceptContent(page)
    await preseedUserDb(page, "en")
    await preseedNonPro(page)

    await page.goto("/")

    // Onboarding shows immediately — no Welcome/loading splash, no tab bar.
    const primary = page.getByTestId("onboarding-primary")
    await expect(primary).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/onboarding/)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
    // Welcome slide CTA.
    await expect(primary).toHaveText(/get started/i)

    // Welcome → Topics
    await primary.click()
    // Topics → Daily wisdom
    await primary.click()
    // Now on the daily-wisdom slide: toggle it on (clickable once in view).
    await page.getByTestId("onboarding-wisdom-toggle").click()
    // Daily wisdom → Value moment
    await primary.click()
    // Value moment → Paywall
    await primary.click()

    // On the paywall the generic primary is hidden; finish via Skip ("Later").
    await expect(primary).toHaveCount(0)
    await page.getByTestId("onboarding-skip").click()

    // Landed on Home.
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.locator("ion-tab-bar")).toBeVisible()

    // Relaunch: onboarding is not replayed (onboarding.completed persisted).
    await page.goto("/")
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
  }
)
