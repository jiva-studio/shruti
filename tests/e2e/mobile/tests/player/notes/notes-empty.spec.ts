import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(
  qase(9, caseTitle(9)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    const notes = page.locator("ion-item.note")
    const sheet = page.locator("ion-action-sheet")
    const deleteButton = sheet.locator("button.action-sheet-destructive")

    await step(page, 9, 0, async () => {
      await gotoTab(page, "notes")

      await expect(notes.first()).toBeVisible({ timeout: 20_000 })

      // Delete notes one at a time. Each tap opens the action sheet; the
      // destructive button removes the note and dismisses the sheet. Cap the loop
      // so a stuck sheet can't spin forever.
      const MAX_ITERATIONS = 20
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const before = await notes.count()
        if (before === 0) break

        await notes.first().click()
        await expect(sheet).toBeVisible({ timeout: 10_000 })
        await expect(deleteButton).toBeVisible({ timeout: 10_000 })
        await deleteButton.click()

        // The sheet animates closed AND the row leaves the DOM. Poll on the count
        // dropping rather than racing the Ionic dismiss animation.
        await expect(sheet).toBeHidden({ timeout: 10_000 })
        await expect(notes).toHaveCount(before - 1, { timeout: 10_000 })
      }
    })

    await step(page, 9, 1, async () => {
      // Every note is gone — the controller's `isEmpty` flips and the PageSticker
      // empty state renders in place of the list.
      await expect(notes).toHaveCount(0)

      const sticker = page.locator(".page-sticker")
      await expect(sticker).toBeVisible({ timeout: 10_000 })
      const header = sticker.locator(".sticker-header")
      await expect(header).toBeVisible()
      const text = (await header.innerText()).trim()
      expect(text.length).toBeGreaterThan(0)
      // Match the rendered i18n header case-insensitively (en fixture → "No notes").
      expect(text.toLowerCase()).toContain("no notes")
    })
  }
)
