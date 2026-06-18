import { type Page } from "@playwright/test"

/**
 * Chat error/quota specs without a backend. We never run the chat server — we
 * intercept the two requests the chat client makes (Playwright route mocks) and
 * fulfil them with crafted responses:
 *   - POST /auth/anonymous → a minted (unsigned) JWT carrying `tier` + `quota_id`
 *     in its base64 middle (the client reads those; it never verifies the sig).
 *   - POST /auth/me        → a matching profile, so no real refresh is attempted.
 * The per-test `/chat` response (an error status + JSON body, or an SSE stream)
 * is registered by each spec.
 */

/** Mint an unsigned JWT whose payload carries the claims the client reads. */
function jwt(claims: Record<string, unknown>): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = Buffer.from(
    JSON.stringify({ exp, tier: "free", quota_id: "q-e2e", ...claims })
  ).toString("base64")
  return `h.${payload}.s`
}

/** Mock the auth endpoints so the app has an anonymous (or Pro) session offline. */
export async function mockChatAuth(page: Page, tier: "free" | "pro" = "free"): Promise<void> {
  const token = jwt({ tier })
  const session = {
    accessToken: token,
    refreshToken: "e2e-refresh",
    userId: "u-e2e",
    email: null,
    name: null,
    anonymous: true,
  }
  await page.route("**/auth/anonymous", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) })
  )
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u-e2e", email: null, name: null, anonymous: true, tier }),
    })
  )
}

/** Type a question into the chat composer and send it. */
export async function askChat(page: Page, text: string): Promise<void> {
  const input = page.locator(".chat-inputbar textarea")
  await input.waitFor({ state: "visible", timeout: 20_000 })
  await input.fill(text)
  await page.locator(".chat-inputbar .send").click()
}
