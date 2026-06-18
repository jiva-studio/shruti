import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openTranscript } from "../../support/nav.js"

// Tapping a transcript sentence seeks playback to it: the tapped block becomes
// the "current" (highlighted) line. (The fixture audio is long enough that the
// seek target isn't clamped.)
test(
  qase(57, "Seek by tapping a transcript timestamp/chapter"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)
    await openTranscript(page)

    const blocks = page.locator(".transcript-text [data-time-start]")
    await expect(blocks.first()).toBeVisible({ timeout: 15_000 })

    // Pick a later sentence whose start is within the (300s) audio.
    const count = await blocks.count()
    let target = blocks.first()
    for (let i = Math.min(count - 1, 12); i >= 1; i--) {
      const start = Number(await blocks.nth(i).getAttribute("data-time-start"))
      if (start > 1000 && start < 250_000) {
        target = blocks.nth(i)
        break
      }
    }

    await target.scrollIntoViewIfNeeded()
    await target.click()

    // The tapped sentence becomes the current line (the seek landed on it).
    await expect(target).toHaveClass(/\bcurrent\b/, { timeout: 10_000 })
  }
)
