import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack, selectTranscriptText } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Notes are created by long-pressing a sentence in the transcript, then tapping
 * the bookmark action in the selection popover (TextSelector → SelectionActions
 * → createNote). There's no non-touch entry point, so we synthesize the
 * touch + long-press + drag gesture via the shared `selectTranscriptText` helper.
 */

test(qase(2, caseTitle(2)), { tag: ["@offline", "@transcript"] }, async ({ page }) => {
  await boot(page)

  let before = 0
  const dialog = page.locator("ion-modal.transcript-dialog")

  await step(page, 2, 0, async () => {
    await gotoTab(page, "notes")
    await expect(page.locator("ion-item.note").first()).toBeVisible({ timeout: 20_000 })
    before = await page.locator("ion-item.note").count()

    // Open a transcript: play a queued track, then tap the player to reveal it.
    await gotoTab(page, "home")
    await playFirstQueuedTrack(page)
    await page.locator(".player").click()
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog.locator(".transcript-text")).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 2, 1, async () => {
    await selectTranscriptText(page)

    // The selection popover's bookmark action (copy=0, bookmark=1) saves the note.
    const actions = page.locator(".selection-actions ion-button")
    await expect(actions.first()).toBeVisible({ timeout: 10_000 })
    await actions.nth(1).click()
  })

  await step(page, 2, 2, async () => {
    // Close the full-screen transcript reader before navigating (it overlays the
    // tab bar and would otherwise swallow the tab tap).
    await dialog.locator(".close-button").first().click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // It shows up in the Notes tab.
    await gotoTab(page, "notes")
    await expect.poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 }).toBe(before + 1)
  })
})
