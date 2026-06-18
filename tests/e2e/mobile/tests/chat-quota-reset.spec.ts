import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"
import { mockChatAuth, askChat } from "../support/chat-mock.js"

// The composer locks on a quota 429, then unlocks itself once the reset deadline
// passes (a near-future reset so the test doesn't wait for real midnight).
test(
  qase(99, "Quota resets and unlocks the composer"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page, "free")
    const resetsAtEpoch = Math.floor(Date.now() / 1000) + 4
    await page.route("**/chat", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { tier: "free", resets_at_epoch: resetsAtEpoch, current: 5, limit: 5, key_type: "user" },
        }),
      })
    )

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "What is the soul?")

    // Locked first…
    await expect(page.locator(".chat-inputbar textarea")).toBeDisabled({ timeout: 10_000 })
    // …then auto-unlocks once the reset deadline passes.
    await expect(page.locator(".chat-inputbar textarea")).not.toBeDisabled({ timeout: 12_000 })
  }
)
