import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { askChat } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { step, caseTitle } from "../../support/steps.js"

// A failed answer offers Retry; tapping it re-sends the same question (a second
// /chat request).
test(
  qase(83, caseTitle(83)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    let calls = 0
    await page.route("**/chat", (route) => {
      calls += 1
      void route.fulfill({ status: 500, body: "" })
    })

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    let retry = page.locator(".inline-notice").first().locator(".btn")
    await step(page, 83, 0, async () => {
      await askChat(page, "What is the soul?")

      // Error notice with a Retry action.
      const notice = page.locator(".inline-notice").first()
      await expect(notice).toBeVisible({ timeout: 20_000 })
      retry = notice.locator(".btn")
      await expect(retry).toBeVisible()
    })

    await step(page, 83, 1, async () => {
      await retry.click()

      // Retry re-sends → a second /chat request fired.
      await expect.poll(() => calls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    })
  }
)
