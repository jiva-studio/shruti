import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatAuth, askChat } from "../../../support/chat-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// A Pro user hitting the quota gets the lock notice but NO "Upgrade to Pro" CTA
// (unlike free). The tier comes from the JWT claim in the mocked auth.
test(
  qase(98, caseTitle(98)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page, "pro")
    const resetsAtEpoch = Math.floor(Date.now() / 1000) + 3600
    await page.route("**/chat", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { tier: "pro", resets_at_epoch: resetsAtEpoch, current: 50, limit: 50, key_type: "user" },
        }),
      })
    )

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    await step(page, 98, 0, async () => {
      await askChat(page, "What is the soul?")

      const notice = page.locator(".inline-notice").first()
      await expect(notice).toBeVisible({ timeout: 20_000 })
      // No upgrade CTA for a Pro user.
      await expect(notice.locator(".btn")).toHaveCount(0)
    })
  }
)
