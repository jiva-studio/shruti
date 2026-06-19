import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { playFirstQueuedTrack } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(60, caseTitle(60)), { tag: ["@offline", "@transcript"] }, async ({ page }) => {
  await boot(page)
  await playFirstQueuedTrack(page)

  await step(page, 60, 0, async () => {
    // The documented gesture: tapping the floating player opens the transcript
    // reader (App.vue → transcriptStore.show). If `openTranscriptAutomatically`
    // already popped it, don't tap again — a second tap would close it.
    const dialog = page.locator("ion-modal.transcript-dialog")
    if (!(await dialog.isVisible())) {
      await page.locator(".player").click()
    }

    await expect(dialog).toBeVisible({ timeout: 20_000 })
    // The transcript body is served from a fixture (trackId patched to match) and
    // rendered into the prompter — assert real text shows, not just the shell.
    await expect(dialog.locator(".transcript-text")).toBeVisible({ timeout: 20_000 })
  })
})
