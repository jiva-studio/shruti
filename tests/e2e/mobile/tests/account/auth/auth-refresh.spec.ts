import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../../support/chat-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/** A JWT whose base64 middle carries the claims the client reads (no sig check). */
function jwt(expSec: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: expSec, tier: "free", quota_id: "q1" })
  ).toString("base64")
  return `h.${payload}.s`
}

// A signed-in session whose access token is about to expire is silently
// refreshed on the next authed call — the user stays signed in (no logout, no
// fallback to anonymous). We seed a near-expiry session, mock /auth/refresh to
// hand back a fresh token, then make an authed call (a chat send) that triggers
// getAccessToken() → refresh.
test(
  qase(114, caseTitle(114)),
  { tag: ["@offline", "@account"] },
  async ({ page }) => {
    // Seed a signed-in session expiring in ~30s (< the 60s refresh threshold).
    await page.addInitScript(() => {
      const exp = Math.floor(Date.now() / 1000) + 30
      const claims = btoa(JSON.stringify({ exp, tier: "free", quota_id: "q1" }))
      const tokens = {
        accessToken: `h.${claims}.s`,
        refreshToken: "e2e-refresh",
        email: "e2e@example.com",
        name: "E2E Tester",
        anonymous: false,
        accessTokenExpiresAt: exp * 1000,
      }
      localStorage.setItem("CapacitorStorage.auth.tokens", JSON.stringify(tokens))
    })

    let refreshHits = 0
    await page.route("**/auth/refresh", (route) => {
      refreshHits++
      // Fresh access token, valid for another hour.
      const fresh = jwt(Math.floor(Date.now() / 1000) + 3600)
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accessToken: fresh,
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
    await mockChatStream(page, [delta("Refreshed and answering."), done()])

    await boot(page)
    await gotoTab(page, "chat")

    await step(page, 114, 0, async () => {
      await askChat(page, "Hello")

      // The authed call triggered a refresh and the answer streamed back.
      await expect(page.getByText(/Refreshed and answering/i)).toBeVisible({ timeout: 20_000 })
      expect(refreshHits, "expected the client to call /auth/refresh").toBeGreaterThanOrEqual(1)
    })

    await step(page, 114, 1, async () => {
      // The session is alive on the fresh token: persisted expiry moved an hour
      // out, and the user is still signed in (non-anonymous).
      const tokens = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("CapacitorStorage.auth.tokens") || "{}")
      )
      expect(tokens.anonymous).toBe(false)
      expect(tokens.accessTokenExpiresAt).toBeGreaterThan(Date.now() + 60_000)
    })
  }
)
