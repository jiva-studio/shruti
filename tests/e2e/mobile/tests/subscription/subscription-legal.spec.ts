import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The subscription screen renders the Privacy Policy and Terms as external
// links. Reach it as a free user via the Pro Autoplay toggle (which opens the
// paywall), then assert the legal anchors and their hrefs.
test(
  qase(107, caseTitle(107)),
  { tag: ["@offline", "@subscription"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "settings")

    await step(page, 107, 0, async () => {
      const toggle = page.locator("ion-item", { hasText: "Autoplay" }).locator("ion-toggle")
      await toggle.scrollIntoViewIfNeeded()
      await toggle.click()
      await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 107, 1, async () => {
      // Privacy Policy link is present (Terms is iOS-only, absent on web).
      const links = page.locator(".subscription-page a.secondary-link[href]")
      await expect(links.first()).toBeVisible({ timeout: 10_000 })
      expect(await links.count()).toBeGreaterThanOrEqual(1)

      const hrefs = await links.evaluateAll((els) => els.map((a) => (a as HTMLAnchorElement).href))
      expect(hrefs.some((h) => h.includes("jiva-studio.github.io"))).toBe(true)
      expect(hrefs.every((h) => /^https?:\/\//.test(h))).toBe(true)
    })
  }
)
