import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"
import { mockChatAuth, mockChatStream, askChat, delta, done } from "../support/chat-mock.js"

// Sending a question shows the user message + a streamed assistant answer (a
// mocked SSE stream — no real backend).
test(
  qase(82, "Send a question and receive a streamed answer"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      delta("The soul is eternal — "),
      delta("it is never born and never dies."),
      done(),
    ])

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "What is the soul?")

    // The question and the streamed answer both render.
    await expect(page.getByText("What is the soul?").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/never born and never dies/i)).toBeVisible({ timeout: 20_000 })
  }
)
