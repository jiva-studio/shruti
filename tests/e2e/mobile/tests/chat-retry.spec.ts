import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"
import { mockChatAuth, askChat } from "../support/chat-mock.js"

// A failed answer offers Retry; tapping it re-sends the same question (a second
// /chat request).
test(
  qase(83, "Truncated/failed answer offers Retry"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    let calls = 0
    await page.route("**/chat", (route) => {
      calls += 1
      void route.fulfill({ status: 500, body: "" })
    })

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "What is the soul?")

    // Error notice with a Retry action.
    const notice = page.locator(".inline-notice").first()
    await expect(notice).toBeVisible({ timeout: 20_000 })
    const retry = notice.locator(".btn")
    await expect(retry).toBeVisible()
    await retry.click()

    // Retry re-sends → a second /chat request fired.
    await expect.poll(() => calls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  }
)
