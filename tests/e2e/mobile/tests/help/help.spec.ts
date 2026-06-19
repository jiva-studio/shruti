import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

const helpDialog = (page: import("@playwright/test").Page) => page.locator("ion-modal.help-dialog")

test(
  qase(123, caseTitle(123)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const dialog = helpDialog(page)
    await step(page, 123, 0, async () => {
      await page.locator("ion-item", { hasText: "Open help" }).click()

      await expect(dialog).toBeVisible({ timeout: 10_000 })
      // The TOC lists help pages (category headers + page rows).
      await expect(dialog.locator("ion-list ion-item").first()).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 123, 1, async () => {
      // Closes cleanly.
      await dialog.getByRole("button", { name: /close/i }).click()
      await expect(dialog).toBeHidden({ timeout: 10_000 })
    })
  }
)

test(
  qase(124, caseTitle(124)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const dialog = helpDialog(page)
    await step(page, 124, 0, async () => {
      await page.locator("ion-item", { hasText: "Open help" }).click()

      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Open the first help page from the TOC.
      await dialog.locator("ion-list ion-item").first().click()

      // The markdown body renders.
      await expect(dialog.locator(".help-md")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 124, 1, async () => {
      // Back returns to the table of contents.
      await dialog.getByRole("button", { name: /back/i }).click()
      await expect(dialog.locator(".help-md")).toBeHidden({ timeout: 10_000 })
      await expect(dialog.locator("ion-list ion-item").first()).toBeVisible({ timeout: 10_000 })
    })
  }
)
