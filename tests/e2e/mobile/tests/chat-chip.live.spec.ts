import { test, expect } from "@playwright/test"
import { qase } from "playwright-qase-reporter"
import { bootLive } from "../support/live.js"

// Real LLM turns are occasionally slow/transient under load — retry @live.
test.describe.configure({ retries: 2 })

test(
  qase(84, "Follow-up suggestion chips"),
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await page.locator("#tab-button-chat").click()

    // The empty-state suggestion row loads async and SHUFFLES once. Clicking
    // mid-shuffle lands on a stale node and the tap is lost — wait for it to
    // render and settle before tapping.
    const chips = page.locator(".suggestions button.chip")
    await expect(chips.first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1200)

    await chips.first().click()

    // "Starts a conversation" = the tap opens a session and sends its query:
    // a user bubble appears and the URL carries the new session id. (The full
    // answer is covered by chat-send.live.)
    await expect(page.locator(".bubble.user, .bubble-row.user").first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page).toHaveURL(/session=/, { timeout: 10_000 })
  }
)
