import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { playFirstQueuedTrack } from "../support/nav.js"

// The transcript is prefetched + cached on boot, so it opens with no network:
// block the transcript route, open the reader, and it still renders from cache.
test(
  qase(81, "Transcript is available offline"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)
    // Let the boot-time prefetch cache the first track's transcript.
    await page.waitForTimeout(2500)

    // Now sever the network for the transcript JSON entirely.
    await page.route("**/public/tracks/*/transcripts/*.json", (route) => route.abort("failed"))

    await playFirstQueuedTrack(page)
    await page.locator(".player").click()

    const dialog = page.locator("ion-modal.transcript-dialog")
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    // Renders from the cache despite the blocked route.
    await expect(dialog.locator(".transcript-text")).toBeVisible({ timeout: 20_000 })
  }
)
