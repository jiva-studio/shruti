import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import {
  claimsOf,
  emailIdentity,
  emailSignInModal,
  E2E_USER_ID,
  jwt,
  mockEmailOtpRequest,
  mockEmailOtpVerify,
  mockMe,
  mockRefresh,
  openEmailSignIn,
  preseedSession,
  storedTokens,
  submitCode,
  submitEmail,
} from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The bearer on the sign-in call has to be one the server can still VERIFY.
 *
 * #210 proves the header is sent; this proves it is fresh. Days offline leave a
 * stored access token stale but present — `callRefresh` deliberately keeps the
 * session on a network error — and reading `stored.accessToken` raw then hands
 * the server a token it cannot verify. It skips the in-place upgrade and mints
 * a stranger, orphaning everything the anonymous account owned (#1737).
 *
 * The verify mock rejects an expired bearer exactly as `Verify` does, so the
 * new account it answers with is the real consequence, not a stand-in.
 */

const EMAIL = "stale@example.com"

test(qase(240, caseTitle(240)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  // Reconnected after a long offline stretch: the stored anonymous token
  // expired an hour ago, and nothing has refreshed it yet.
  await preseedSession(page, {
    anonymous: true,
    email: null,
    name: null,
    expiresInSec: -3600,
  })
  // Refresh stays unavailable for the whole boot, so the stale token is still
  // the stored one when sign-in starts — a transient failure keeps the session
  // by design (`callRefresh`), which is exactly how a token goes stale in the
  // field. It is granted at the moment the code is submitted, so a rotation
  // observed on the verify can only have been the sign-in's own.
  let refreshAvailable = false
  let refreshesGranted = 0
  await mockRefresh(page, () => {
    if (!refreshAvailable) return { ok: false, status: 503 }
    refreshesGranted++
    return { ok: true, tokens: { accessToken: jwt({ sub: E2E_USER_ID }), anonymous: true } }
  })
  let verified = false
  await mockMe(page, () => ({
    ok: true,
    user: verified
      ? { anonymous: false, email: EMAIL, identities: [emailIdentity(EMAIL)] }
      : {},
  }))
  await mockEmailOtpRequest(page)
  const verify = await mockEmailOtpVerify(page, () => {
    verified = true
    return { ok: true }
  })

  await boot(page, "en", { userDb: "clean" })

  await step(page, 240, 0, async () => {
    const before = await storedTokens(page)
    expect(before.userId, "the account the offline session belongs to").toBe(E2E_USER_ID)
    expect(before.anonymous).toBe(true)
    expect(Number(before.accessTokenExpiresAt), "and its token is long expired").toBeLessThan(
      Date.now()
    )
  })

  await step(page, 240, 1, async () => {
    await gotoTab(page, "settings")
    await openEmailSignIn(page)
    await submitEmail(page, EMAIL)
    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    refreshAvailable = true
    await submitCode(page, "123456")
    await expect(emailSignInModal(page)).toBeHidden({ timeout: 15_000 })
  })

  await step(page, 240, 2, async () => {
    // The client rotated the token before signing in, so the server could read
    // it — the whole difference between an upgrade and a fork.
    expect(refreshesGranted, "the stale token was rotated first").toBeGreaterThan(0)
    const exp = claimsOf(verify.last?.bearer ?? null).exp
    expect(typeof exp === "number" && exp * 1000 > Date.now()).toBe(true)
  })

  await step(page, 240, 3, async () => {
    const after = await storedTokens(page)
    expect(after.userId, "the anonymous account was upgraded, not orphaned").toBe(E2E_USER_ID)
    expect(after.anonymous).toBe(false)
  })
})
