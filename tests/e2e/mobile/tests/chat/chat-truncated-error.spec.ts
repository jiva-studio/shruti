import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { mockChatStream, askChat, delta, errorFrame } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A server-reported failure that lands AFTER the first tokens (#1795). The
 * socket is healthy — the agent timed out — so the bubble must keep the
 * partial prose and say the answer could not be completed, not that the
 * connection dropped. The wrong label also used to send the store polling
 * `GET /chat/turn` for a turn that had already failed.
 */
test(
  qase(349, caseTitle(349)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      delta("The soul is eternal — "),
      errorFrame("turn_timeout", "turn timed out"),
    ])

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    await step(page, 349, 0, async () => {
      await askChat(page, "What is the soul?")

      // The prose that did arrive is kept.
      await expect(page.getByText(/The soul is eternal/i)).toBeVisible({ timeout: 20_000 })
    })

    await step(page, 349, 1, async () => {
      const suffix = page.locator(".truncated-suffix").last()
      await expect(suffix).toBeVisible({ timeout: 20_000 })
      await expect(suffix).toHaveText(/couldn't be completed/i)
      await expect(suffix).not.toHaveText(/connection dropped/i)
    })
  }
)
