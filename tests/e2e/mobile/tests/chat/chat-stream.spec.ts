import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { mockChatAuth, mockChatStream, askChat, delta, done } from "../../support/chat-mock.js"
import { step, caseTitle } from "../../support/steps.js"

// Sending a question shows the user message + a streamed assistant answer (a
// mocked SSE stream — no real backend).
test(
  qase(82, caseTitle(82)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      delta("The soul is eternal — "),
      delta("it is never born and never dies."),
      done(),
    ])

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    await step(page, 82, 0, async () => {
      await askChat(page, "What is the soul?")

      // The question renders as a user bubble.
      await expect(page.getByText("What is the soul?").first()).toBeVisible({ timeout: 15_000 })
    })

    await step(page, 82, 1, async () => {
      // The streamed answer renders.
      await expect(page.getByText(/never born and never dies/i)).toBeVisible({ timeout: 20_000 })
    })
  }
)
