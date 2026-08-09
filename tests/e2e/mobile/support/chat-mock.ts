import { type BrowserContext, type Page } from "@playwright/test"

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

/** The anonymous session handed to the app in place of a real one. */
function anonymousSession(tier: "free" | "pro"): string {
  return JSON.stringify({
    accessToken: jwt({ tier }),
    refreshToken: "e2e-refresh",
    userId: "u-e2e",
    email: null,
    name: null,
    anonymous: true,
  })
}

/**
 * Suite-wide default for `POST /auth/anonymous`, installed for every spec by
 * the auto fixture in `support/test.ts`.
 *
 * This is the endpoint that mints accounts, and only 9 of 89 specs used to mock
 * it — the other 80 created a real production user on every run. Making it a
 * default rather than an opt-in is the whole point: an opt-in guard only covers
 * the specs that remembered it.
 *
 * Registered at CONTEXT level, which Playwright matches *after* page-level
 * routes, so {@link mockChatAuth} and any spec's own `page.route` still win.
 *
 * Deliberately narrow: `/auth/me` and `/auth/refresh` are NOT defaulted. They
 * describe *which* session the app has, and a blanket anonymous answer would
 * contradict the specs that seed a signed-in one (`preseedAuthTokens`,
 * `auth-refresh`). Those endpoints can no longer leak either — the mocked
 * region points them at the dead loopback sink.
 */
export async function installDefaultAnonymousAuth(context: BrowserContext): Promise<void> {
  await context.route("**/auth/anonymous", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: anonymousSession("free"),
    })
  )
}

/** Mock the auth endpoints so the app has an anonymous (or Pro) session offline. */
export async function mockChatAuth(page: Page, tier: "free" | "pro" = "free"): Promise<void> {
  await page.route("**/auth/anonymous", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: anonymousSession(tier),
    })
  )
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ userId: "u-e2e", email: null, name: null, anonymous: true, tier }),
    })
  )
}

/* ------------------------------- SSE stream ------------------------------- */

/** One `delta` frame (a chunk of answer text). */
export function delta(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ text })}`
}
/** The terminal `done` frame (optionally carrying the cite-alias map). */
export function done(aliases?: Record<string, unknown>): string {
  return `event: done\ndata: ${JSON.stringify(aliases ? { aliases } : {})}`
}
/** An `action` frame (e.g. a share-PDF action card). */
export function action(data: Record<string, unknown>): string {
  return `event: action\ndata: ${JSON.stringify(data)}`
}

/** Mock POST /chat as a streamed SSE answer built from the given frames. */
export async function mockChatStream(page: Page, frames: string[]): Promise<void> {
  const body = frames.map((f) => `${f}\n\n`).join("")
  await page.route("**/chat", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body })
  )
}

/**
 * The composer's send/stop control. It is the only button in the input bar, so
 * ask for it by role rather than by the round shell's own class — that class is
 * `FloatingInputButton`'s (`.action`), shared with the search field, and has
 * already been renamed once under the specs.
 */
export function sendButton(page: Page) {
  return page.locator(".chat-inputbar").getByRole("button")
}

/** Type a question into the chat composer and send it. */
export async function askChat(page: Page, text: string): Promise<void> {
  const input = page.locator(".chat-inputbar textarea")
  await input.waitFor({ state: "visible", timeout: 20_000 })
  await input.fill(text)
  await sendButton(page).click()
}
