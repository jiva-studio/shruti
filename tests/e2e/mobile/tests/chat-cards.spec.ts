import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// Pure offline render of the richest chat bubble. The seeded session
// (`chat_demo_soul`, title "What is the soul?", see
// modules/tools/screenshots/generate-fixtures/chat.ts) carries an assistant
// message whose `meta` holds a BG 2.20 verse body (`[verse:…/2.20|BG 2.20]`)
// and a citation snippet (`[cite:track_0dRAV1Swc3ak@…|…]`). With both bodies
// present the renderer shows the full VerseCard (`.scripture-block`) and the
// full CitationCard (`.citation-card`) — no network needed.

test(
  qase([89, 90], "Verse chip upgrades to a verse card"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "chat")

    // Open the history sheet (mirrors chat-history.spec.ts).
    await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()

    // Open the seeded "What is the soul?" session.
    const session = page.locator("ion-modal.chat-session-list ion-item", {
      hasText: /soul/i,
    })
    await expect(session.first()).toBeVisible({ timeout: 10_000 })
    await session.first().click()

    // Verse card (BG 2.20) renders as a block, with the address visible.
    const verse = page.locator(".scripture-block")
    await expect(verse.first()).toBeVisible({ timeout: 10_000 })
    await expect(verse.first()).toContainText("2.20")

    // Citation snippet was seeded, so the full citation card (not the chip)
    // renders.
    const citation = page.locator(".citation-card, .citation-chip")
    await expect(citation.first()).toBeVisible({ timeout: 10_000 })
  }
)
