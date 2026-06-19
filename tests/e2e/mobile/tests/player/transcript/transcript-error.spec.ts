import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { playFirstQueuedTrack } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// When the transcript fails to load, the reader shows an error state (not an
// endless spinner).
test(
  qase(64, caseTitle(64)),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "single" })

    // The transcript is prefetched + cached on boot, so a route failure alone is
    // bypassed by the cache. Clear the cache so the reader must hit the network,
    // then fail that request → the loader surfaces the error state.
    await page.evaluate(async () => {
      for (const k of await caches.keys()) await caches.delete(k)
    })
    await page.route("**/public/tracks/*/transcripts/*.json", (route) => route.abort("failed"))

    const dialog = page.locator("ion-modal.transcript-dialog")

    await step(page, 64, 0, async () => {
      await playFirstQueuedTrack(page)
      await page.locator(".player").click()

      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(dialog.locator(".transcript-error")).toBeVisible({ timeout: 25_000 })
    })
  }
)
