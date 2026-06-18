import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { playFirstQueuedTrack } from "../support/nav.js"

// When the transcript fails to load, the reader shows an error state (not an
// endless spinner) and can be dismissed.
test(
  qase(64, "Transcript loading, error and empty states"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)

    // The transcript is prefetched + cached on boot, so a route failure alone is
    // bypassed by the cache. Clear the cache so the reader must hit the network,
    // then fail that request → the loader surfaces the error state.
    await page.evaluate(async () => {
      for (const k of await caches.keys()) await caches.delete(k)
    })
    await page.route("**/public/tracks/*/transcripts/*.json", (route) => route.abort("failed"))

    await playFirstQueuedTrack(page)
    await page.locator(".player").click()

    const dialog = page.locator("ion-modal.transcript-dialog")
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog.locator(".transcript-error")).toBeVisible({ timeout: 25_000 })

    // The dialog dismisses cleanly.
    await dialog.locator(".close-button").click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })
  }
)
