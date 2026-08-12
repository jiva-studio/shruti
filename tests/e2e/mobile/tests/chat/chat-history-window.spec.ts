import { type Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { askChat, delta, done } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Issue #1771. `ChatRequestDto.messages` is `max_length=20` and pydantic
 * REJECTS a longer list — so a client that replayed its whole local history
 * turned 422 on the 21st message and the conversation was unsendable forever
 * (422 is not transient, and Retry re-sent the same body).
 *
 * A route mock can't reproduce the 422 by itself — it would only prove we can
 * render an error. What the fix has to be pinned on is the REQUEST: this spec
 * builds a real 20-message conversation through the UI (ten mocked turns, each
 * persisted to the app's own SQLite) and then inspects the body of the 21st
 * send.
 */

/** The server's cap — mirrors CHAT_HISTORY_WINDOW in infra/chat/http/chatClient.ts. */
const WINDOW = 20

interface WireBody {
  messages: { role: string; content: string }[]
}

/** Mock POST /chat with a per-turn answer, recording every request body. */
async function mockCountingChat(page: Page): Promise<WireBody[]> {
  const bodies: WireBody[] = []
  await page.route("**/chat", (route) => {
    bodies.push(route.request().postDataJSON() as WireBody)
    const frames = [delta(`Answer number ${bodies.length}.`), done()]
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: frames.map((f) => `${f}\n\n`).join(""),
    })
  })
  return bodies
}

test(qase(283, caseTitle(283)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  const bodies = await mockCountingChat(page)

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  await step(page, 283, 0, async () => {
    // Ten question/answer exchanges = 20 stored messages, exactly the server's
    // window. Everything up to here already worked before the fix.
    for (let i = 1; i <= WINDOW / 2; i++) {
      await askChat(page, `Question number ${i}?`)
      await expect(page.getByText(`Answer number ${i}.`)).toBeVisible({ timeout: 30_000 })
    }
    expect(bodies).toHaveLength(WINDOW / 2)
    // The tenth send carried nine exchanges plus the new question — 19 turns,
    // still under the cap. The next one is where it used to break.
    expect(bodies[bodies.length - 1]?.messages).toHaveLength(WINDOW - 1)
  })

  await step(page, 283, 1, async () => {
    // The 21st message. Pre-fix this shipped 21 turns and came back 422.
    await askChat(page, "Question number 11?")
    await expect(page.getByText("Answer number 11.")).toBeVisible({ timeout: 30_000 })
  })

  await step(page, 283, 2, async () => {
    const sent = bodies[bodies.length - 1]?.messages ?? []
    // Capped at the server's window...
    expect(sent).toHaveLength(WINDOW)
    // ...and it is the NEWEST turns that survived: the question just asked is
    // last, and the opening exchange has scrolled out.
    expect(sent[sent.length - 1]?.content).toBe("Question number 11?")
    expect(sent.some((m) => m.content === "Question number 1?")).toBe(false)
    // No error bubble — the turn was answered, not refused.
    await expect(page.locator(".chat-page").getByText(/went wrong|error/i)).toHaveCount(0)
  })
})
