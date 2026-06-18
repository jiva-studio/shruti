import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"

// Starting a new session clears the conversation to the empty/welcome state
// while the prior session stays in history. Uses the seeded "What is the soul?"
// session (no chat backend needed) — mirrors chat-cards/chat-history specs.
test(
  qase(95, "Start a new session"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "chat")

    // Open a seeded past session so there are messages to start anew from.
    await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()
    const session = page.locator("ion-modal.chat-session-list ion-item", { hasText: /soul/i })
    await expect(session.first()).toBeVisible({ timeout: 10_000 })
    await session.first().click()

    // The conversation is shown (message list present, new-session button visible).
    const newSession = page.locator('.chat-page .action-btn[aria-label="New chat"]')
    await expect(newSession).toBeVisible({ timeout: 10_000 })

    await newSession.click()

    // Back to the empty/welcome state: the PageSticker + suggestion chips show.
    await expect(page.locator(".suggestions")).toBeVisible({ timeout: 10_000 })

    // The prior session is still in history.
    await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()
    await expect(
      page.locator("ion-modal.chat-session-list ion-item", { hasText: /soul/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  }
)
