import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Tapping a note opens an `IonActionSheet` (`onNoteClicked` in
 * NotesView.controller.ts). Its buttons are Copy text · Share · Delete
 * (role "destructive") · Cancel. Ionic renders a destructive-role button with
 * the class `action-sheet-destructive`, so we target that — locale-independent
 * and stable across the localized "Delete" label.
 */
test(
  qase(5, caseTitle(5)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    const sheet = page.locator("ion-action-sheet")
    let before = 0

    await step(page, 5, 0, async () => {
      await gotoTab(page, "notes")

      const notes = page.locator("ion-item.note")
      await expect(notes.first()).toBeVisible({ timeout: 20_000 })
      before = await notes.count()
      expect(before).toBeGreaterThan(0)

      // Open the per-note action sheet.
      await notes.first().click()
      await expect(sheet).toBeVisible({ timeout: 10_000 })

      // The destructive Delete button (role: "destructive" → action-sheet-destructive).
      const deleteButton = sheet.locator("button.action-sheet-destructive")
      await expect(deleteButton).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 5, 1, async () => {
      const deleteButton = sheet.locator("button.action-sheet-destructive")
      await deleteButton.click()

      // The sheet dismisses and the list shrinks by exactly one.
      await expect(sheet).toBeHidden({ timeout: 10_000 })
      await expect
        .poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 })
        .toBe(before - 1)
    })
  }
)
