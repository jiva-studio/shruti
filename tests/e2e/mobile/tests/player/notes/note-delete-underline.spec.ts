import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTranscript, selectTranscriptText } from "../../../support/nav.js"

// Deleting a note from its transcript underline: create a note (drag-select →
// bookmark), tap the resulting underlined span to reopen the popover in
// existing-note mode (red Delete present), tap Delete — the underline is
// removed and the note disappears from the Notes tab.
test(
  qase(6, "Delete a note from the transcript underline"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)

    await gotoTab(page, "notes")
    await expect(page.locator("ion-item.note").first()).toBeVisible({ timeout: 20_000 })
    const before = await page.locator("ion-item.note").count()

    // Open the transcript and create a note from a selection.
    await gotoTab(page, "home")
    await openTranscript(page)
    await selectTranscriptText(page)
    await page.locator(".selection-actions ion-button").nth(1).click() // bookmark

    // The saved note paints a wavy underline (`.highlighted`); the create
    // popover closes once the bookmark is saved.
    const highlighted = page.locator(".transcript-text .highlighted")
    await expect(highlighted.first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(".selection-actions")).toBeHidden({ timeout: 10_000 })

    // Tap the underline → popover reopens in existing-note mode with a red
    // Delete. The block only emits `noteTapped` once its `noteIds` resolve
    // (a beat after the underline paints); before that a tap just seeks. Retry
    // the tap until the Delete affordance appears.
    const del = page.locator('.selection-actions ion-button[color="danger"]')
    await expect(async () => {
      await highlighted.first().click()
      await expect(del).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 20_000 })
    await del.click()

    // The underline is removed immediately.
    await expect(page.locator(".transcript-text .highlighted")).toHaveCount(0, { timeout: 10_000 })

    // And the note is gone from the Notes tab.
    const dialog = page.locator("ion-modal.transcript-dialog")
    await dialog.locator(".close-button").first().click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })
    await gotoTab(page, "notes")
    await expect
      .poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 })
      .toBe(before)
  }
)
