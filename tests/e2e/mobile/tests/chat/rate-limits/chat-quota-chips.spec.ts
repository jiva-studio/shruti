import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { askChat } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// The quota lock used to disable exactly one widget — the textarea. Every other
// entry point into `sendMessage` stayed live, so a locked user could tap "New
// chat", tap a suggestion pill, and spend another increment of a server counter
// that is bumped before the comparison and never refunded — plus a dead session
// per tap (issue #1780).
test(
  qase(307, caseTitle(307)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page, "free")
    // Far enough out that the lock cannot lift mid-test (which would also arm
    // the store's automatic re-send and make the request count ambiguous).
    const resetsAtEpoch = Math.floor(Date.now() / 1000) + 3600

    let asked = 0
    await page.route("**/chat", (route) => {
      asked += 1
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { tier: "free", resets_at_epoch: resetsAtEpoch, current: 5, limit: 5, key_type: "user" },
        }),
      })
    })

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    const textarea = page.locator(".chat-inputbar textarea")
    const newSession = page.locator('.chat-page .action-btn[aria-label="New chat"]')
    // Scoped to the chat page: `.suggestions` is also the playlist starter packs.
    const chips = page.locator(".chat-page .suggestions .chip")

    await step(page, 307, 0, async () => {
      await askChat(page, "What is the soul?")
      await expect(textarea).toBeDisabled({ timeout: 15_000 })
      expect(asked).toBe(1)
    })

    await step(page, 307, 1, async () => {
      // "New chat" is reachable while locked — it clears the thread without
      // touching the deadline — so the empty state and its pills come back.
      await newSession.click()
      await expect(chips.first()).toBeVisible({ timeout: 10_000 })
      // The pills are the affordance half of the fix: a chip that can no
      // longer send says so, dimmed alongside the still-disabled composer,
      // instead of swallowing the tap.
      await expect(chips.first()).toBeDisabled()
      await expect(textarea).toBeDisabled()
    })

    await step(page, 307, 2, async () => {
      // A real tap first — the browser drops it on a disabled button…
      await chips.first().click({ force: true })
      // …then the same click dispatched programmatically, which a disabled
      // button does NOT suppress. That reaches the Vue handler and therefore
      // `sendMessage` itself, so this step fails if EITHER the chip's disabled
      // state or the store's own lock guard is removed.
      await chips.first().dispatchEvent("click")

      // Give a send every chance to leave.
      await page.waitForTimeout(1_500)

      // Nothing did: no second request against the quota, no thread born from
      // the tap (the empty state is still on screen), composer still locked.
      expect(asked).toBe(1)
      await expect(page.locator(".chat-message-list")).toHaveCount(0)
      await expect(chips.first()).toBeVisible()
      await expect(textarea).toBeDisabled()
    })
  }
)
