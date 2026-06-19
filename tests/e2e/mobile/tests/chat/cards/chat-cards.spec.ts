import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// What these verify is the WIDGET, not the answer prose. A seeded assistant
// message (chat_demo_soul, "What is the soul?", see
// modules/tools/screenshots/generate-fixtures/chat.ts) carries a BG 2.20 verse
// body and a citation snippet in its `meta`. With both present the renderer must
// upgrade the inline markers into a full VerseCard (`.scripture-block`) and a
// full CitationCard (`.citation-card`) — not bare chips. Pure offline. Steps +
// titles come from the qase/cases.json registry.

async function openSoulSession(page: import("@playwright/test").Page) {
  await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()
  const session = page.locator("ion-modal.chat-session-list ion-item", { hasText: /soul/i })
  await expect(session.first()).toBeVisible({ timeout: 10_000 })
  await session.first().click()
}

test(qase(89, caseTitle(89)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page, "en")
  await gotoTab(page, "chat")
  await step(page, 89, 0, async () => {
    await openSoulSession(page)
    const verse = page.locator(".scripture-block")
    await expect(verse.first()).toBeVisible({ timeout: 10_000 })
    await expect(verse.first()).toContainText("2.20")
  })
})

test(qase(90, caseTitle(90)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page, "en")
  await gotoTab(page, "chat")
  await step(page, 90, 0, async () => {
    await openSoulSession(page)
    await expect(page.locator(".citation-card").first()).toBeVisible({ timeout: 10_000 })
  })
})
