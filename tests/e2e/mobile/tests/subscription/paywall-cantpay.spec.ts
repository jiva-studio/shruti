import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// On the Russian build a non-Pro user sees a "Can't pay" support entry on the
// paywall (RU has no working IAP). Reach the paywall via a Pro toggle.
//
// DISABLED: the "Не могу оплатить" support screen has been turned off for now
// (the paywall screen that expected payment to appear was removed).
//
// `test.fixme` rather than a comment block: a commented-out test is invisible
// twice over — the run reports every spec green while this Qase case silently
// receives no result at all, so nobody can tell a disabled case from one that
// was never written. Kept, not deleted, until the screen is decided on.
test.fixme(
  qase(106, caseTitle(106)),
  { tag: ["@offline", "@subscription"] },
  async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("CapacitorStorage.settings.appLanguage", JSON.stringify("ru"))
      } catch {
        // non-fatal
      }
    })
    await boot(page, "ru", { userDb: "clean" })
    await gotoTab(page, "settings")

    await step(page, 106, 0, async () => {
      // The first Pro-badged toggle (Autoplay) — "PRO" badge text is locale-stable.
      const proToggle = page.locator("ion-item", { hasText: "PRO" }).locator("ion-toggle").first()
      await proToggle.scrollIntoViewIfNeeded()
      await proToggle.click()

      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 106, 1, async () => {
      await expect(page.getByText("Не могу оплатить")).toBeVisible({ timeout: 10_000 })
    })
  }
)
