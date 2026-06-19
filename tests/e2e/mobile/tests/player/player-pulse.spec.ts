import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { playFirstQueuedTrack } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The floating mini-player pulses (a looping invite animation) until the user
// opens the transcript for the first time; once opened, the pulse stops for
// good. We assert on the `pulsing` CLASS (boot() zeroes animation durations, so
// the class — not a computed animation — is the stable signal).
test(
  qase(53, caseTitle(53)),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "single" })
    await playFirstQueuedTrack(page)

    const player = page.locator(".player")
    await step(page, 53, 0, async () => {
      await expect(player).toHaveClass(/\bpulsing\b/, { timeout: 10_000 })
    })

    await step(page, 53, 1, async () => {
      // Opening the transcript (tap the player) dismisses the tutorial pulse.
      await player.click()
      await expect(page.locator("ion-modal.transcript-dialog")).toBeVisible({ timeout: 20_000 })

      await expect(player).not.toHaveClass(/\bpulsing\b/, { timeout: 10_000 })
    })
  }
)
