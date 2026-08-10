import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { checkedAppLanguage, gotoTab, localeChunkUrl, pickAppLanguage } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Picking a language whose chunk cannot be fetched used to persist the choice
 * immediately and move the checkmark, then fail the load — so the setting
 * claimed Deutsch while every string on screen stayed English, and because the
 * preference was already written the mismatch survived every restart
 * (issue #1606). The rejection also escaped as an unhandled promise.
 *
 * The invariant asserted here: the picker never claims a language the UI is not
 * showing. The failure is surfaced, the setting stays where it was, and a
 * reload does not resurrect the phantom choice.
 */
test(qase(170, caseTitle(170)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await page.route(localeChunkUrl("de"), (route) => void route.abort("failed"))

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "settings")

  await step(page, 170, 0, async () => {
    await pickAppLanguage(page, "Deutsch")

    // The failure is told, not swallowed.
    await expect(page.locator("ion-toast")).toBeVisible({ timeout: 20_000 })
    // The UI never left English…
    await expect(
      page.locator("ion-item", { hasText: "Language of an interface" }).first()
    ).toBeVisible()
    // …so the setting must not say otherwise.
    expect(await checkedAppLanguage(page)).toBe("English")
  })

  await step(page, 170, 1, async () => {
    // A preference written on a failed switch would come back on every launch.
    await page.reload()
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await gotoTab(page, "settings")

    await expect(
      page.locator("ion-item", { hasText: "Language of an interface" }).first()
    ).toBeVisible({ timeout: 20_000 })
    expect(await checkedAppLanguage(page)).toBe("English")
  })
})
