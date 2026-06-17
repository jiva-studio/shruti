import { test, expect, type Page } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack } from "../support/nav.js"

/**
 * Notes are created by long-pressing a sentence in the transcript, then tapping
 * the bookmark action in the selection popover (TextSelector → SelectionActions
 * → createNote). There's no non-touch entry point, so we synthesize the
 * pointer/touch + long-press gesture on the first sentence span.
 */
async function selectTranscriptText(page: Page): Promise<void> {
  // Real touch via CDP: long-press a sentence, then DRAG to a later sentence,
  // then release. The drag (touchMove) is essential — TextSelector only commits
  // a selection that has been extended; start→hold→release alone never opens the
  // popover. center() of two spans gives the gesture path.
  const spans = page.locator(".transcript-text [data-time-start][data-time-end]")
  await spans.first().scrollIntoViewIfNeeded()
  const n = await spans.count()
  const b1 = await spans.nth(0).boundingBox()
  const b2 = await spans.nth(Math.min(2, n - 1)).boundingBox()
  if (!b1 || !b2) throw new Error("no transcript sentence spans found")
  const p1 = { x: Math.round(b1.x + b1.width / 2), y: Math.round(b1.y + b1.height / 2) }
  const p2 = { x: Math.round(b2.x + b2.width / 2), y: Math.round(b2.y + b2.height / 2) }

  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p1] })
  await page.waitForTimeout(650) // past the ~500ms long-press threshold
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p2] })
  await page.waitForTimeout(250)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

test("transcript · creating a note from a selection", { tag: ["@offline", "@transcript"] }, async ({ page }) => {
  await boot(page)

  await gotoTab(page, "notes")
  await expect(page.locator("ion-item.note").first()).toBeVisible({ timeout: 20_000 })
  const before = await page.locator("ion-item.note").count()

  // Open a transcript: play a queued track, then tap the player to reveal it.
  await gotoTab(page, "home")
  await playFirstQueuedTrack(page)
  await page.locator(".player").click()
  const dialog = page.locator("ion-modal.transcript-dialog")
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog.locator(".transcript-text")).toBeVisible({ timeout: 20_000 })

  await selectTranscriptText(page)

  // The selection popover's bookmark action (copy=0, bookmark=1) saves the note.
  const actions = page.locator(".selection-actions ion-button")
  await expect(actions.first()).toBeVisible({ timeout: 10_000 })
  await actions.nth(1).click()

  // Close the full-screen transcript reader before navigating (it overlays the
  // tab bar and would otherwise swallow the tab tap).
  await dialog.locator(".close-button").first().click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })

  // It shows up in the Notes tab.
  await gotoTab(page, "notes")
  await expect.poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 }).toBe(before + 1)
})
