import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Issue #1784 — the unread dot outliving its conversation.
 *
 * The reply has to land while the user is NOT looking at that conversation
 * (that is the only thing that lights the dot for an answer), and the
 * conversation then has to be deleted without ever being opened (opening it
 * was the only thing that cleared the dot). The mocked answer is therefore
 * held back long enough for the user to start a new chat and walk to Home.
 */
test(qase(319, caseTitle(319)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(
    page,
    [delta("The soul is eternal — "), delta("it is never born and never dies."), done()],
    { delayMs: 3000 }
  )

  // Clean fixture: the conversation this spec creates is the only one in
  // history, so the row it deletes is unambiguous.
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  const dot = page.locator(".chat-tab-button .proactive-dot")
  const historyBtn = page.locator('.chat-page .action-btn[aria-label="Chat history"]')
  const newSession = page.locator('.chat-page .action-btn[aria-label="New chat"]')
  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  const sessions = modal.locator("ion-item-sliding")
  // Scoped to the chat page: `.suggestions` is also Home's playlist starter
  // packs, and the Home tab stays mounted behind this one once visited — so
  // an unscoped locator matches two elements as soon as the featured
  // collections finish loading, and fails on strict mode.
  const chips = page.locator(".chat-page .suggestions")

  await step(page, 319, 0, async () => {
    await askChat(page, "What is the soul?")
    await expect(page.getByText("What is the soul?").first()).toBeVisible({ timeout: 15_000 })

    // Leave the conversation while its turn is still running — "New chat"
    // drops `?session=` from the URL, so the reply arrives with nobody
    // viewing it, and returning to the tab lands on the empty state rather
    // than back inside the thread.
    await newSession.click()
    await expect(chips).toBeVisible({ timeout: 10_000 })
    await gotoTab(page, "home")
  })

  await step(page, 319, 1, async () => {
    // The answer settles in the background and lights the Sadhu tab dot.
    await expect(dot).toBeVisible({ timeout: 30_000 })
  })

  await step(page, 319, 2, async () => {
    await gotoTab(page, "chat")
    // Still the empty state — the conversation is never opened.
    await expect(chips).toBeVisible({ timeout: 10_000 })
    await expect(dot).toBeVisible()

    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(sessions).toHaveCount(1, { timeout: 10_000 })
  })

  await step(page, 319, 3, async () => {
    await sessions
      .first()
      .evaluate((el: HTMLElement & { open(side?: string): Promise<void> }) => el.open("end"))
    await modal.locator('ion-item-option[color="danger"]').first().click()
    await expect(sessions).toHaveCount(0, { timeout: 10_000 })

    // The dot goes out with the conversation. Re-opening history reloads the
    // sessions list — the path that used to union the orphaned id straight
    // back into the badge set.
    await expect(dot).toHaveCount(0, { timeout: 10_000 })
    await modal.getByRole("button", { name: "Close" }).click()
    await expect(modal).toHaveCount(0, { timeout: 10_000 })
    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(dot).toHaveCount(0)
  })
})
