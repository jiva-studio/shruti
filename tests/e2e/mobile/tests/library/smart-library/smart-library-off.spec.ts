import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Switching Smart Library off must stop it doing anything — including the half
 * that deletes.
 *
 * The archive schedule used to have no "off" entry at all: turning the feature
 * off left the sweep running, and the radio group displayed "After 1 day" while
 * the stored value said otherwise, because the group was bound to a computed
 * that filled in a default. Case 49 only ever touches the Enable toggle, so
 * neither the missing option nor the lying display was covered.
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
    // The schedule offers "Never" — the option that used not to exist.
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
