import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { askChat, action, delta, done } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// A chapter row on an outline card asks for a recap turn, and `sendMessage`
// refuses one while the quota lock is armed. Every other send-capable control in
// the thread dims; the outline card had no `quotaLocked` at all, so it sat lit
// among greyed-out siblings and ate the tap (issue #1841).

const TRACK = "track_outline_e2e"

const OUTLINE = action({
  kind: "outline",
  id: "o1",
  payload: {
    track_id: TRACK,
    items: [
      { start_ms: 0, title: "Opening prayers" },
      { start_ms: 60_000, title: "The nature of the soul" },
    ],
  },
})

test(qase(460, caseTitle(460)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page, "free")
  // Far enough out that the lock cannot lift mid-test.
  const resetsAtEpoch = Math.floor(Date.now() / 1000) + 3600

  let asked = 0
  await page.route("**/chat", async (route) => {
    asked += 1
    // First turn answers with the outline card; every turn after it is over
    // the daily limit.
    if (asked === 1) {
      const body = [delta("Here is the outline:\n\n"), delta(`[outline:${TRACK}]`), OUTLINE, done()]
        .map((f) => `${f}\n\n`)
        .join("")
      return route.fulfill({ status: 200, contentType: "text/event-stream", body })
    }
    return route.fulfill({
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

  const textarea = page.locator(".chat-inputbar textarea")
  const chapters = page.locator(".outline-card button.chapter")

  await step(page, 460, 0, async () => {
    await askChat(page, "What is in this lecture?")
    await expect(chapters.first()).toBeVisible({ timeout: 20_000 })
    // While the quota is open the rows are live — that is what makes the
    // dimming below a change of state and not the card's resting look.
    await expect(chapters.first()).toBeEnabled()
    await expect(textarea).not.toBeDisabled({ timeout: 20_000 })
  })

  await step(page, 460, 1, async () => {
    await askChat(page, "And the next one?")
    // Wait for the LOCK itself, not merely for a send in flight — the limit
    // notice renders from the 429 answer and from nothing else.
    await expect(page.locator(".inline-notice").first()).toBeVisible({ timeout: 20_000 })
    await expect(textarea).toBeDisabled()
    // The card is still on screen from the first answer, and now reads as
    // blocked instead of broken.
    await expect(chapters.first()).toBeDisabled()
    expect(asked).toBe(2)
  })

  await step(page, 460, 2, async () => {
    // A real tap first — the browser drops it on a disabled button…
    await chapters.first().click({ force: true })
    // …then the same click dispatched programmatically, which a disabled
    // button does NOT suppress. That reaches the Vue handler and therefore
    // `sendMessage`, so this step fails if either the row's disabled state or
    // the store's own lock guard is removed.
    await chapters.first().dispatchEvent("click")
    await page.waitForTimeout(1_500)

    expect(asked).toBe(2)
    await expect(textarea).toBeDisabled()
  })
})
