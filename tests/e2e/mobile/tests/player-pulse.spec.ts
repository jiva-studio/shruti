import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { playFirstQueuedTrack } from "../support/nav.js"

// The floating mini-player pulses (a looping invite animation) until the user
// opens the transcript for the first time; once opened, the pulse stops for
// good. We assert on the `pulsing` CLASS (boot() zeroes animation durations, so
// the class — not a computed animation — is the stable signal).
test(
  qase(53, "Floating mini-player pulses until the transcript is opened"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    const player = page.locator(".player")
    await expect(player).toHaveClass(/\bpulsing\b/, { timeout: 10_000 })

    // Opening the transcript (tap the player) dismisses the tutorial pulse.
    await player.click()
    await expect(page.locator("ion-modal.transcript-dialog")).toBeVisible({ timeout: 20_000 })

    await expect(player).not.toHaveClass(/\bpulsing\b/, { timeout: 10_000 })
  }
)
