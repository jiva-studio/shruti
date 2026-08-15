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

// A `/auth/refresh` that opens a socket and then never answers used to take the
// whole session with it: the call is memoised in `refreshInFlight` and cleared
// only in a `finally` the request never reached, so every later
// `getAccessToken()` — chat, sync, ingest, discovery — awaited the same dead
// promise until the app was force-quit (#1832).
//
// Note the shape: the route HANGS, it does not fail. Plain offline never
// reproduced this, because `fetch` rejects immediately and the `finally` runs.
test(
  qase(381, caseTitle(381)),
  { tag: ["@offline", "@account"] },
  async ({ page }) => {
    // Two request deadlines have to actually elapse here — the point is the
    // wall clock, and it cannot be mocked from outside the app.
    test.slow()

    // Signed-in session expiring in ~30s — under the 60s threshold, so the next
    // authed call takes the forced-refresh path.
    await page.addInitScript(() => {
      const exp = Math.floor(Date.now() / 1000) + 30
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

    // Held open for the lifetime of the test, then released so Playwright's
    // teardown isn't left waiting on an unfinished route handler.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let answering = false
    let refreshHits = 0
    await page.route("**/auth/refresh", async (route) => {
      refreshHits += 1
      // Held open until the test lets the service answer again. Fulfilling is
      // best-effort: by then the client has usually aborted this one already.
      if (!answering) await gate
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
            refreshToken: "e2e-refresh-2",
            userId: "u-e2e",
            anonymous: false,
          }),
        })
        .catch(() => {})
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
    await mockChatStream(page, [delta("Back on speaking terms."), done()])

    try {
      await boot(page, "en", { userDb: "clean" })
      await gotoTab(page, "chat")

      await step(page, 381, 0, async () => {
        await askChat(page, "What is the soul?")

        // A SECOND `/auth/refresh` is the whole assertion. The call is
        // memoised, so with no deadline there can only ever be one: the first
        // hung socket owns `refreshInFlight` for the life of the process and
        // every later caller joins that dead promise. Reaching two proves the
        // first was bounded and released the mutex.
        await expect.poll(() => refreshHits, { timeout: 90_000 }).toBeGreaterThanOrEqual(2)
      })

      await step(page, 381, 1, async () => {
        // The send comes back rather than sitting on thinking dots forever, and
        // the session is usable again the moment the service answers: tapping
        // Retry rotates the token and the new expiry is persisted. No
        // force-quit — which is the only cure the wedged build had.
        const retry = page.getByRole("button", { name: "Retry" })
        await expect(retry).toBeVisible({ timeout: 90_000 })

        answering = true
        release()
        await retry.click()

        const expiry = (): Promise<number> =>
          page.evaluate(
            () =>
              (JSON.parse(localStorage.getItem("CapacitorStorage.auth.tokens") || "{}")
                .accessTokenExpiresAt as number) ?? 0
          )
        await expect.poll(expiry, { timeout: 60_000 }).toBeGreaterThan(Date.now() + 60_000)
      })
    } finally {
      release()
    }
  }
)
