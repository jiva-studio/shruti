import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openSelectorDialog } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * How much disk downloaded lectures may occupy.
 *
 * Before this setting existed, adding a seminar queued a hundred lectures at
 * ~34 MB each with nothing said about it. The row is therefore not decoration:
 * it is the only place the budget can be seen or changed, and its subtitle
 * carries the live figure so the number is not abstract.
 *
 * Persistence is the second half — a limit that forgets itself between launches
 * is the same as no limit at all.
 */
test(qase(180, caseTitle(180)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "settings")

  const row = page.locator("ion-item", { hasText: "Download limit" }).first()

  await step(page, 180, 0, async () => {
    // The row is there, and it says what is used against what is allowed.
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("p")).toHaveText(/of 8 GB$/)
  })

  await step(page, 180, 1, async (capture) => {
    // Tapping opens the chooser, which offers the presets and "no limit".
    await row.click()
    const dialog = openSelectorDialog(page)
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator("ion-radio", { hasText: "No limit" })).toBeVisible()
    await capture()
    await dialog.locator("ion-radio", { hasText: /^1 GB$/ }).click()
    await dialog.getByRole("button", { name: /apply/i }).click()
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  })

  await step(page, 180, 2, async () => {
    // The subtitle re-renders against the new budget.
    await expect(row.locator("p")).toHaveText(/of 1 GB$/, { timeout: 10_000 })
  })

  await step(page, 180, 3, async () => {
    // And the choice outlives the launch that made it.
    await page.reload()
    await page.waitForURL("**/tabs/**", { timeout: 60_000 })
    await gotoTab(page, "settings")
    await row.scrollIntoViewIfNeeded()
    await expect(row.locator("p")).toHaveText(/of 1 GB$/, { timeout: 15_000 })
  })
})
