import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase(115, caseTitle(115)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "settings")

  const dialog = page.locator(".selector-dialog")
  await step(page, 115, 0, async () => {
    // Open the interface-language selector (distinct from the "Chat language" row).
    await page.locator("ion-item", { hasText: "Language of an interface" }).click()
    await expect(dialog.locator("ion-radio").first()).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 115, 1, async () => {
    // Pick Russian, then Apply (the dialog commits on the Apply button, not on select).
    await dialog.locator("ion-radio", { hasText: /рус|russian/i }).click()
    await dialog.getByRole("button", { name: /apply|примен/i }).click()

    // The whole UI re-renders in Russian — the same settings row now reads "Язык".
    await expect(page.locator("ion-item", { hasText: "Язык" }).first()).toBeVisible({ timeout: 10_000 })
  })
})
