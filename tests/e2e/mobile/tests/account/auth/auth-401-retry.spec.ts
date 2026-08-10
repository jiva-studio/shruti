import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../../support/chat-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A 401 is recoverable, and recovering costs exactly one refresh.
 *
 * Case 114 covers the *proactive* refresh: a token whose `exp` is near, renewed
 * before it is used. That leaves the case the user actually hits — a token the
 * client believes is good and the server rejects, typically because the device
 * clock is off — where the request simply failed, the answer never arrived, and
 * nothing retried.
 *
 * The token here is seeded an hour out, so nothing proactive can fire: the only
 * thing that can produce a refresh is the 401 itself.
 */
function jwt(expSec: number): string {
  const claims = Buffer.from(
    JSON.stringify({ exp: expSec, tier: "free", quota_id: "q1" })
  ).toString("base64")
  return `h.${claims}.s`
}

test(qase(188, caseTitle(188)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  await page.addInitScript(() => {
    // Far-future expiry: the client has no reason to refresh on its own.
    const exp = Math.floor(Date.now() / 1000) + 3600
    const claims = btoa(JSON.stringify({ exp, tier: "free", quota_id: "q1" }))
    localStorage.setItem(
      "CapacitorStorage.auth.tokens",
      JSON.stringify({
        accessToken: `h.${claims}.s`,
        refreshToken: "e2e-refresh",
        email: "e2e@example.com",
        name: "E2E Tester",
        anonymous: false,
        accessTokenExpiresAt: exp * 1000,
      })
    )
  })

  let refreshHits = 0
  await page.route("**/auth/refresh", (route) => {
    refreshHits++
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "e2e-refresh-2",
        userId: "u-e2e",
        anonymous: false,
      }),
    })
  })
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        userId: "u-e2e",
        email: "e2e@example.com",
        name: "E2E Tester",
        anonymous: false,
        tier: "free",
      }),
    })
  )

  // The server rejects the first authed call and accepts the replay.
  let chatHits = 0
  await mockChatStream(page, [delta("Answered after the retry."), done()])
  await page.route("**/chat", async (route) => {
    chatHits++
    if (chatHits === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      })
      return
    }
    await route.fallback()
  })

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  await step(page, 188, 0, async () => {
    await askChat(page, "Hello")
    // The answer arrives despite the rejection — the 401 is not terminal.
    await expect(page.getByText(/Answered after the retry/i)).toBeVisible({ timeout: 30_000 })
  })

  await step(page, 188, 1, async () => {
    // Exactly one refresh, and the request was genuinely replayed rather than
    // reported as a failure the user has to repeat by hand.
    expect(refreshHits, "a 401 must trigger exactly one refresh").toBe(1)
    expect(chatHits, "the rejected request must be replayed once").toBe(2)
  })

  await step(page, 188, 2, async () => {
    // And the session survived: no silent drop to anonymous.
    const tokens = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("CapacitorStorage.auth.tokens") || "{}")
    )
    expect(tokens.anonymous).toBe(false)
  })
})
