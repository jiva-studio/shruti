import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatAuth, askChat } from "../../../support/chat-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// A 429 with a free-tier quota body locks the composer and shows the limit notice.
test(
  qase(97, caseTitle(97)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page, "free")
    const resetsAtEpoch = Math.floor(Date.now() / 1000) + 3600
    await page.route("**/chat", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { tier: "free", resets_at_epoch: resetsAtEpoch, current: 5, limit: 5, key_type: "user" },
        }),
      })
    )

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    await step(page, 97, 0, async () => {
      await askChat(page, "What is the soul?")

      // The composer is locked and a notice is shown.
      await expect(page.locator(".chat-inputbar textarea")).toBeDisabled({ timeout: 15_000 })
      await expect(page.locator(".inline-notice").first()).toBeVisible({ timeout: 10_000 })
    })
  }
)
