import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"
import { mockChatAuth, askChat } from "../support/chat-mock.js"

// When the rate-limit checker (Redis) is down, the server 503s with a specific
// code; the client shows a toast but keeps the composer usable (no hard lock).
test(
  qase(100, "Rate-limit backend unavailable keeps composer usable"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await page.route("**/chat", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: { code: "rate_limit_backend_unavailable" } }),
      })
    )

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "What is the soul?")

    // The defining behaviour: the composer stays usable (NOT quota-locked) — the
    // server admitted it couldn't gate, so there's no hard lock. (Wait out the
    // client's transient-503 retries first.)
    await expect(page.locator(".chat-inputbar textarea")).not.toBeDisabled({ timeout: 20_000 })
    await expect(page.locator(".chat-inputbar textarea")).toBeEditable()
  }
)
