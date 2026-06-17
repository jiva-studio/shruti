import { test, expect } from "@playwright/test"
import { bootLive, askChat, assistantBubble } from "../support/live.js"

// Real LLM turns are occasionally slow/transient under load — retry @live. The
// grounded-answer poll waits up to 180s, so the per-test budget must exceed that
// (the global 120s default would kill a slow-but-valid turn before the poll).
test.describe.configure({ retries: 2, timeout: 240_000 })

/**
 * @live — needs the local stack (chat + auth) up. A real chat turn end to end:
 * the local service streams a grounded answer back. Answers can take up to a
 * couple of minutes, so the assertion timeout is deliberately generous.
 */
test(
  "chat · send a message → grounded streamed reply",
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "What is bhakti?")

    // The user's message echoes into the thread immediately.
    await expect(page.locator(".bubble.user, .bubble-row.user").last()).toContainText("bhakti", {
      timeout: 20_000,
    })

    // A SUBSTANTIAL grounded answer streams in (not just a "Thinking…" pill).
    const assistant = assistantBubble(page)
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await assistant.innerText()).trim().length, {
        timeout: 180_000,
        intervals: [3000],
      })
      .toBeGreaterThan(80)
  }
)
