import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../../support/chat-mock.js"
import {
  mockAnonymous,
  mockMe,
  mockRefresh,
  preseedSession,
  storedTokens,
} from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A backend that is merely down must not sign anybody out.
 *
 * `callRefresh` splits a failed refresh into two outcomes that look identical
 * from the call site: REJECTED (the refresh token is dead — drop the session)
 * and TRANSIENT (mid-deploy, rate-limited, offline — keep it and try again
 * later). Collapsing them is the classic bug: everyone is logged out whenever
 * auth restarts, and nobody can tell it from a normal expiry.
 *
 * A 5xx reaches the adapter as a THROW, not as a response: the region failover
 * client tries every server and then raises `Error("HTTP 5xx")`. So the branch
 * that has to hold the line for an auth outage is `callRefresh`'s catch — the
 * one place that decides an unanswered refresh is not a rejection — and
 * flipping it (`rejected: true`) makes this spec fail on every assertion below.
 *
 * Cases 114 and 188 only ever see a refresh SUCCEED and 191 only a `/me` blip,
 * so the branch that decides whether to clear the session has never been
 * executed by a test.
 *
 * What is asserted is not "the session looks intact right after the 503" —
 * that read races the client's own handling of the answer and passes either
 * way. It is that the NEXT authed call recovers by refreshing the same session,
 * and that no anonymous identity was minted along the way: a client that
 * mistook the outage for a rejection would have thrown the account away and
 * bootstrapped a stranger, and the chat would answer just the same.
 */

test(qase(207, caseTitle(207)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  // Inside the 60s refresh window, so every authed call goes through
  // forceRefresh() rather than reusing the token.
  await preseedSession(page, { expiresInSec: 30 })
  await mockMe(page, { ok: true, user: { anonymous: false, email: "e2e@example.com" } })
  // How many accounts the app minted. Must stay zero: this device already has
  // one, and the only reason to mint another is having lost it.
  const minted = await mockAnonymous(page)

  let outage = true
  const refresh = await mockRefresh(page, () => (outage ? { ok: false, status: 503 } : { ok: true }))
  await mockChatStream(page, [delta("Answered once auth came back."), done()])

  await boot(page, "en", { userDb: "clean" })

  let refusals = 0
  await step(page, 207, 0, async () => {
    // Auth is mid-deploy: every refresh the app attempts is refused.
    await expect.poll(() => refresh.count, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    refusals = refresh.count
  })

  await step(page, 207, 1, async () => {
    outage = false
    await gotoTab(page, "chat")
    await askChat(page, "Hello")

    await expect(page.getByText(/Answered once auth came back/i)).toBeVisible({ timeout: 30_000 })

    // The send needed a token and got one by REFRESHING — not by minting a new
    // account, which is what a client that had dropped the session would do.
    expect(refresh.count, "the outage did not end the session's life").toBeGreaterThan(refusals)
    expect(minted.count, "no second account was created").toBe(0)
  })

  await step(page, 207, 2, async () => {
    const tokens = await storedTokens(page)
    expect(tokens.anonymous, "a 503 is not a rejection").toBe(false)

    // And the user-visible half: still themselves in Settings, not back at the
    // anonymous "Sign in" call to action.
    await gotoTab(page, "settings")
    const row = page.locator("ion-item", { hasText: "E2E Tester" })
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 15_000 })
  })
})
