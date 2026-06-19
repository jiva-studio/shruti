import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Chat history is ONE feature, walked end-to-end against the offline
// fixture-seeded sessions (chat_demo_soul "What is the soul?", see
// modules/tools/screenshots/generate-fixtures/chat.ts) — no backend:
//   step 0  open the history sheet            → seeded sessions are listed
//   step 1  open a prior session              → its messages load
//   step 2  start a new chat                  → empty state + suggestion chips
//   step 3  delete a session                  → the list count drops by one
// (Consolidates the former 93/94 open-history, 95 new-session, 96 delete cases.)
test(qase(93, caseTitle(93)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page, "en")
  await gotoTab(page, "chat")

  const historyBtn = page.locator('.chat-page .action-btn[aria-label="Chat history"]')
  const newSession = page.locator('.chat-page .action-btn[aria-label="New chat"]')
  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  const sessions = modal.locator("ion-item-sliding")

  await step(page, 93, 0, async (capture) => {
    // Open the history sheet; the seeded demo session ("What is the soul?") is listed.
    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    const session = modal.locator("ion-item", { hasText: /soul|душа/i })
    await expect(session.first()).toBeVisible({ timeout: 10_000 })
    // Screenshot the history sheet before navigating into a session dismisses it.
    await capture()
  })

  await step(page, 93, 1, async () => {
    // Open the prior session — its conversation loads (new-session button shown).
    await modal.locator("ion-item", { hasText: /soul|душа/i }).first().click()
    await expect(newSession).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 93, 2, async () => {
    // Start a new chat — back to the empty/welcome state with suggestion chips.
    await newSession.click()
    await expect(page.locator(".suggestions")).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 93, 3, async () => {
    // Re-open history; swipe the first session open and tap its delete (danger)
    // option — the list count drops by one.
    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(sessions.first()).toBeVisible({ timeout: 10_000 })
    const before = await sessions.count()
    expect(before).toBeGreaterThan(0)

    await sessions
      .first()
      .evaluate((el: HTMLElement & { open(side?: string): Promise<void> }) => el.open("end"))
    await modal.locator('ion-item-option[color="danger"]').first().click()

    await expect
      .poll(() => modal.locator("ion-item-sliding").count(), { timeout: 10_000 })
      .toBe(before - 1)
  })
})
