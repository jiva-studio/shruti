import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Switching Smart Library off must stop it doing anything — including the half
 * that deletes.
 *
 * The archive schedule has a "Never" entry, and the radio group shows the
 * stored value rather than a filled-in default. The smart-library dialog spec
 * only touches the Enable toggle, so this is the spec that covers both.
 */
test(qase(183, caseTitle(183)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })
  await gotoTab(page, "search")

  const dialog = page.locator("ion-modal.smart-library-dialog")
  const enable = dialog.locator("ion-toggle").first()

  await step(page, 183, 0, async () => {
    const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
    await banner.scrollIntoViewIfNeeded()
    await banner.click()
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(enable).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 183, 1, async (capture) => {
    // The schedule offers "Never".
    if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
    const never = dialog.locator("ion-radio", { hasText: "Never" }).first()
    await expect(never).toBeVisible({ timeout: 10_000 })
    await capture()
  })

  await step(page, 183, 2, async () => {
    // Picking it holds: the group shows what is stored, not a filled-in default.
    const never = dialog.locator("ion-radio", { hasText: "Never" }).first()
    await never.click()
    await expect(never).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    const daily = dialog.locator("ion-radio", { hasText: "After 1 day" }).first()
    await expect(daily).toHaveAttribute("aria-checked", "false")
  })
})
