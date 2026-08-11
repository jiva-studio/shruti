import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { askChat, delta, done } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// The composer locks on a quota 429, then unlocks itself once the reset deadline
// passes (a near-future reset so the test doesn't wait for real midnight) — and
// the upsell card must go WITH it, taking its screenful of reserved scroll room,
// while the question the quota swallowed is re-asked (issue #1609).
test(
  qase(99, caseTitle(99)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page, "free")
    // Far enough out that the locked state is observable after boot, near
    // enough that the test doesn't wait for real UTC midnight.
    const resetsAtEpoch = Math.floor(Date.now() / 1000) + 12

    // First ask is refused by the quota; anything after the reset streams a real
    // answer, so we can see whether the question was actually re-sent.
    let asked = 0
    const answer = [delta("The soul is eternal."), done()].map((f) => `${f}\n\n`).join("")
    await page.route("**/chat", (route) => {
      asked += 1
      if (asked === 1) {
        return route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({
            detail: { tier: "free", resets_at_epoch: resetsAtEpoch, current: 5, limit: 5, key_type: "user" },
          }),
        })
      }
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: answer })
    })

    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "chat")

    await step(page, 99, 0, async () => {
      await askChat(page, "What is the soul?")

      // Locked first…
      await expect(page.locator(".chat-inputbar textarea")).toBeDisabled({ timeout: 10_000 })
      // …behind the upsell card, which is the whole visible content of the bubble.
      await expect(page.locator(".inline-notice").first()).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 99, 1, async () => {
      // …then auto-unlocks once the reset deadline passes.
      await expect(page.locator(".chat-inputbar textarea")).not.toBeDisabled({ timeout: 25_000 })
    })

    await step(page, 99, 2, async () => {
      // The card must not linger as an error-less, content-less row: it kept
      // the tail slot's `min-height: calc(100svh - 200px)` reservation, so the
      // user was left scrolling a screen of blank space (issue #1609).
      await expect(page.locator(".inline-notice")).toHaveCount(0, { timeout: 25_000 })
      // Not merely error-less: the ROW itself is gone. Stripping `error` and
      // keeping the row left an empty bubble that still reserved the tail
      // slot's `min-height: calc(100svh - 200px)` — a screenful of blank.
      // (The in-flight re-send's own placeholder is `.streaming`.)
      const blanks = page.locator(".bubble.assistant:not(.streaming)").filter({ hasText: /^\s*$/ })
      await expect(blanks).toHaveCount(0)
    })

    await step(page, 99, 3, async () => {
      // And the question the quota swallowed is asked again under the lifted
      // limit, rather than silently dropped.
      await expect(page.getByText("The soul is eternal.")).toBeVisible({ timeout: 20_000 })
      expect(asked).toBeGreaterThan(1)
    })
  }
)
