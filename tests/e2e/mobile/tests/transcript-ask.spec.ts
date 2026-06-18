import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openTranscript, selectTranscriptText, selectionAction } from "../support/nav.js"

test(
  qase(61, "transcript · ask about a selection opens a chat"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)
    await openTranscript(page)
    await selectTranscriptText(page)

    // "Ask" hands the selection to the chat as the start of a scoped conversation.
    await selectionAction(page, "ask").click()

    // We land on the chat surface (the streamed answer itself is a @live concern).
    await expect(page.locator(".chat-page")).toBeVisible({ timeout: 20_000 })
  }
)
