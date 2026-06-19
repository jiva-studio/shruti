import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The floating player hides in overlapping contexts. The Chat tab is one such
// context: the player is hidden there and returns when leaving it. (The keyboard
// context is native-only and not asserted offline.)
test(
  qase(58, caseTitle(58)),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    const player = page.locator(".player")
    await expect(player).not.toHaveClass(/\bhidden\b/)

    await step(page, 58, 0, async () => {
      // On the Chat tab the floating player is hidden.
      await gotoTab(page, "chat")
      await expect(player).toHaveClass(/\bhidden\b/, { timeout: 10_000 })
    })

    await step(page, 58, 1, async () => {
      // Leaving Chat brings it back.
      await gotoTab(page, "home")
      await expect(player).not.toHaveClass(/\bhidden\b/, { timeout: 10_000 })
    })
  }
)
