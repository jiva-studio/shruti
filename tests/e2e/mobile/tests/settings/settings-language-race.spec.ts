import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, localeChunkUrl, pickAppLanguage } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Two UI-language switches in quick succession resolve in FETCH order, not in
 * the order they were made: the second pick is often already resident and wins
 * in a microtask while the first is still on the wire. Applying a chunk
 * unconditionally when it lands therefore stranded the whole UI in the language
 * the user did not pick, while the setting and the picker still read the one
 * they did (issue #1606) — and it survived navigation, so it read as a one-off
 * glitch nobody could reproduce.
 *
 * Held here deterministically: the Ukrainian chunk is parked in a `page.route`
 * handler until the German switch has completed, then released.
 */
test(qase(169, caseTitle(169)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(localeChunkUrl("uk"), async (route) => {
    await held
    await route.continue()
  })

  await boot(page, "ru", { userDb: "clean" })
  await gotoTab(page, "settings")

  await step(page, 169, 0, async () => {
    // Українська goes on the wire and stays there.
    await pickAppLanguage(page, "Українська")
    // Change of mind inside the RTT: Deutsch, whose chunk is not held.
    await pickAppLanguage(page, "Deutsch")

    await expect(page.locator("ion-item", { hasText: "Sprache der Oberfläche" })).toBeVisible({
      timeout: 20_000,
    })
  })

  await step(page, 169, 1, async () => {
    const landed = page.waitForResponse((r) => r.url().includes("/i18n/bundles/uk.ts"))
    release()
    await landed
    // The overtaken chunk applies (or doesn't) a microtask after it evaluates,
    // so give it a beat — an immediate assertion would pass either way.
    await page.waitForTimeout(1_000)

    await expect(page.locator("ion-item", { hasText: "Мова інтерфейсу" })).toHaveCount(0)
    await expect(page.locator("ion-item", { hasText: "Sprache der Oberfläche" })).toBeVisible()
  })
})
