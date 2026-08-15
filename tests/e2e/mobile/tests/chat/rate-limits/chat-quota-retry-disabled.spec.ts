import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { askChat, delta, errorFrame } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Issue #1837. `retryLast` deletes the user prompt and the assistant reply —
 * from SQLite, and through the sync journal from the user's other devices —
 * BEFORE re-sending, and a send while the quota lock is armed returns on its
 * first line. So an enabled Retry there erased a question everywhere and
 * started nothing, with nothing on screen to say so.
 *
 * The lock lives on the store, not on the session, so the reachable shape is
 * a truncated tail in ONE conversation and a 429 earned in another.
 */
test(qase(350, caseTitle(350)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page, "free")
  const resetsAtEpoch = Math.floor(Date.now() / 1000) + 3600
  let calls = 0
  await page.route("**/chat", async (route) => {
    calls += 1
    if (calls === 1) {
      // A turn cut short by the agent's turn limit. `truncated` is the one
      // failure kind that round-trips through SQLite (`parseError` keeps
      // `stream` and `turns` only), and unlike a transport drop it starts no
      // resume poll — so the bubble is still the tail, still carrying Retry,
      // when the session is reopened.
      const body = [delta("The soul is eternal — "), errorFrame("max_turns_exceeded", "too many")]
        .map((f) => `${f}\n\n`)
        .join("")
      await route.fulfill({ status: 200, contentType: "text/event-stream", body })
      return
    }
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        detail: {
          tier: "free",
          resets_at_epoch: resetsAtEpoch,
          current: 5,
          limit: 5,
          key_type: "user",
        },
      }),
    })
  })

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  const historyBtn = page.locator('.chat-page .action-btn[aria-label="Chat history"]')
  const newSession = page.locator('.chat-page .action-btn[aria-label="New chat"]')
  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  const retry = page.locator('.message-action[aria-label="Retry"]')

  await step(page, 350, 0, async () => {
    await askChat(page, "What is the soul?")
    await expect(page.getByText(/The soul is eternal/i)).toBeVisible({ timeout: 20_000 })
    await expect(retry).toBeVisible({ timeout: 20_000 })
    await expect(retry).toBeEnabled()
  })

  await step(page, 350, 1, async () => {
    await newSession.click()
    await askChat(page, "And what is the mind?")
    await expect(page.locator(".chat-inputbar textarea")).toBeDisabled({ timeout: 20_000 })
  })

  await step(page, 350, 2, async () => {
    // Back to the first conversation: its truncated answer is the tail again,
    // while the lock earned in the other one is still armed.
    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await modal.locator("ion-item", { hasText: /soul/i }).first().click()
    await expect(page.getByText(/The soul is eternal/i)).toBeVisible({ timeout: 20_000 })

    await expect(retry).toBeVisible({ timeout: 20_000 })
    await expect(retry).toBeDisabled()

    // Tapping it must be inert in the harmless sense — not in the sense that
    // ate the turn. `dispatchEvent` reaches the handler a real tap on a
    // disabled button would not, which is the guard being asserted.
    const before = calls
    await retry.dispatchEvent("click")
    await expect(page.getByText("What is the soul?").first()).toBeVisible()
    await expect(page.getByText(/The soul is eternal/i)).toBeVisible()
    expect(calls).toBe(before)
  })
})
