import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../../support/chat-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A `/me` blip must not cost the user their name.
 *
 * Every token commit — and a refresh is one — follows the new token with a
 * `GET /auth/me`. That lookup is best-effort and its failure is silent: the
 * client cannot tell a 502 from a genuinely empty profile. The session was
 * rebuilt from the `/me` answer alone, so a blip wrote `email`, `name` and
 * `picture` to null AND persisted them. Nothing recovers that until some later
 * refresh happens to catch `/me` working, so a signed-in user just stops having
 * a name — across restarts.
 *
 * Cases 114 and 188 both drive this same commit path with `/me` answering 200,
 * and both assert only token fields, so neither can see it.
 */
function jwt(expSec: number): string {
  const claims = Buffer.from(
    JSON.stringify({ exp: expSec, tier: "free", quota_id: "q1" })
  ).toString("base64")
  return `h.${claims}.s`
}

const AVATAR = "https://cdn.test/reader.png"

test(qase(191, caseTitle(191)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  // A signed-in session expiring inside the 60s refresh threshold, so the next
  // authed call goes through the forced-refresh path.
  await page.addInitScript(() => {
    const exp = Math.floor(Date.now() / 1000) + 30
    const claims = btoa(JSON.stringify({ exp, tier: "free", quota_id: "q1" }))
    localStorage.setItem(
      "CapacitorStorage.auth.tokens",
      JSON.stringify({
        accessToken: `h.${claims}.s`,
        refreshToken: "e2e-refresh",
        userId: "u-e2e",
        email: "e2e@example.com",
        name: "E2E Tester",
        picture: "https://cdn.test/reader.png",
        anonymous: false,
        accessTokenExpiresAt: exp * 1000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "q1",
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

  // The blip: the profile lookup that rides along with the refresh is down.
  let meHits = 0
  await page.route("**/auth/me", (route) => {
    meHits++
    void route.fulfill({ status: 502, contentType: "application/json", body: "{}" })
  })

  await mockChatStream(page, [delta("Answered on the refreshed token."), done()])

  await boot(page, "en", { userDb: "clean" })

  await step(page, 191, 0, async () => {
    await gotoTab(page, "chat")
    await askChat(page, "Hello")

    // The refresh itself worked — this is not a signed-out session.
    await expect(page.getByText(/Answered on the refreshed token/i)).toBeVisible({
      timeout: 30_000,
    })
    expect(refreshHits, "the near-expiry token must be refreshed").toBeGreaterThanOrEqual(1)
    expect(meHits, "the commit must have attempted the profile lookup").toBeGreaterThanOrEqual(1)
  })

  await step(page, 191, 1, async () => {
    await gotoTab(page, "settings")

    // The user-visible consequence: the account row is still theirs.
    const row = page.locator("ion-item", { hasText: "E2E Tester" })
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 10_000 })
  })

  await step(page, 191, 2, async () => {
    // And it survives a restart, because what was written to Preferences is
    // the profile and not three nulls.
    const tokens = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("CapacitorStorage.auth.tokens") || "{}")
    )
    expect(tokens.name).toBe("E2E Tester")
    expect(tokens.email).toBe("e2e@example.com")
    expect(tokens.picture).toBe(AVATAR)
    expect(tokens.anonymous).toBe(false)
  })
})
