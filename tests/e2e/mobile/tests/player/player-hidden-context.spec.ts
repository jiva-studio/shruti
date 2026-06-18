import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack } from "../../support/nav.js"

// The floating player hides in overlapping contexts. The Chat tab is one such
// context: the player is hidden there and returns when leaving it. (The keyboard
// context is native-only and not asserted offline.)
test(
  qase(58, "Floating player hides in overlapping contexts"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    const player = page.locator(".player")
    await expect(player).not.toHaveClass(/\bhidden\b/)

    // On the Chat tab the floating player is hidden.
    await gotoTab(page, "chat")
    await expect(player).toHaveClass(/\bhidden\b/, { timeout: 10_000 })

    // Leaving Chat brings it back.
    await gotoTab(page, "home")
    await expect(player).not.toHaveClass(/\bhidden\b/, { timeout: 10_000 })
  }
)
