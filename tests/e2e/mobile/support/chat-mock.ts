import { type Page } from "@playwright/test"

/**
 * Chat error/quota specs without a backend. We never run the chat server — we
 * intercept the requests the chat client makes (Playwright route mocks) and
 * fulfil them with crafted responses. The identity half of that lives in
 * `support/auth-mock.ts` (`mockChatAuth` mints the anonymous session and its
 * matching `/auth/me`); the per-test `/chat` response — an error status + JSON
 * body, or an SSE stream — is registered here by each spec.
 */

/* ------------------------------- SSE stream ------------------------------- */

/** One `delta` frame (a chunk of answer text). */
export function delta(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ text })}`
}
/** The terminal `done` frame (optionally carrying the cite-alias map). */
export function done(aliases?: Record<string, unknown>): string {
  return `event: done\ndata: ${JSON.stringify(aliases ? { aliases } : {})}`
}
/**
 * A `status` frame — what the thinking pill says while the server works.
 * `key` is resolved against `chat.status.<key>` (unknown keys fall back to
 * "Thinking…"), so pass one the app actually has copy for.
 */
export function status(key: string, params?: Record<string, string | number>): string {
  return `event: status\ndata: ${JSON.stringify(params ? { key, params } : { key })}`
}
/** An `action` frame (e.g. a share-PDF action card). */
export function action(data: Record<string, unknown>): string {
  return `event: action\ndata: ${JSON.stringify(data)}`
}

/**
 * Mock POST /chat as a streamed SSE answer built from the given frames.
 *
 * `delayMs` holds the answer back before fulfilling, which is what makes a
 * turn observable as "still running": the default fulfils instantly, so a spec
 * cannot get anywhere (leave the session, switch tabs) before it settles.
 */
export async function mockChatStream(
  page: Page,
  frames: string[],
  opts: { delayMs?: number } = {}
): Promise<void> {
  const body = frames.map((f) => `${f}\n\n`).join("")
  await page.route("**/chat", async (route) => {
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    await route.fulfill({ status: 200, contentType: "text/event-stream", body })
  })
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
