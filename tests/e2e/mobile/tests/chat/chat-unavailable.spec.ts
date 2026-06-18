import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { mockChatAuth, askChat } from "../../support/chat-mock.js"

// When the chat backend is down, sending surfaces an inline notice (with Retry)
// and the message is not silently lost — all without a real backend.
test(
  qase(88, "Chat service unavailable UX"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await page.route("**/chat", (route) => route.fulfill({ status: 500, body: "" }))

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "What is the soul?")

    // The question stays on screen and an error notice appears.
    await expect(page.getByText("What is the soul?").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(".inline-notice").first()).toBeVisible({ timeout: 25_000 })
  }
)
