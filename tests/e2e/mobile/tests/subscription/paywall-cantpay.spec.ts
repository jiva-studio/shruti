import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// On the Russian build a non-Pro user sees a "Can't pay" support entry on the
// paywall (RU has no working IAP). Reach the paywall via a Pro toggle.
test(
  qase(106, caseTitle(106)),
  { tag: ["@offline", "@subscription"] },
  async ({ page }) => {
    await boot(page, "ru")
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
