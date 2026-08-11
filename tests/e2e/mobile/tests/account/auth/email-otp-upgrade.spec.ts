import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import {
  claimsOf,
  emailIdentity,
  emailSignInModal,
  E2E_USER_ID,
  mockEmailOtpRequest,
  mockEmailOtpVerify,
  mockMe,
  openEmailSignIn,
  storedTokens,
  submitCode,
  submitEmail,
} from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * Signing in must not cost the user their account.
 *
 * Everyone starts anonymous — that identity already owns the listening history,
 * notes and chats — and email sign-in is supposed to UPGRADE it in place rather
 * than mint a second one. The mechanism is one line in the adapter: the
 * anonymous access token is attached as a Bearer to `signin/email/*`, which is
 * what tells the server which user to claim. Drop that header and the server
 * has no choice but to create a stranger, and the loss is silent.
 *
 * The verify mock models exactly that server behaviour — it echoes the `sub` of
 * whatever bearer it was handed, and answers with a fresh id when handed none —
 * so this fails if the header ever goes missing.
 */

const EMAIL = "upgrade@example.com"
const NAME = "Upgraded Reader"

test(qase(210, caseTitle(210)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  let verified = false
  await mockMe(page, () => ({
    ok: true,
    user: verified
      ? { anonymous: false, email: EMAIL, name: NAME, identities: [emailIdentity(EMAIL)] }
      : {},
  }))
  await mockEmailOtpRequest(page)
  const verify = await mockEmailOtpVerify(page, () => {
    verified = true
    return { ok: true }
  })

  await boot(page, "en", { userDb: "clean" })

  await step(page, 210, 0, async () => {
    // The account the app bootstrapped itself into on first launch.
    const before = await storedTokens(page)
    expect(before.anonymous, "the app starts anonymous").toBe(true)
    expect(before.userId).toBe(E2E_USER_ID)
  })

  await step(page, 210, 1, async () => {
    await gotoTab(page, "settings")
    await openEmailSignIn(page)
    await submitEmail(page, EMAIL)
    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await submitCode(page, "123456")
    await expect(emailSignInModal(page)).toBeHidden({ timeout: 15_000 })
  })

  await step(page, 210, 2, async () => {
    // The header that makes the in-place upgrade possible.
    expect(verify.last?.bearer, "verify must carry the anonymous bearer").not.toBeNull()
    expect(claimsOf(verify.last?.bearer ?? null).sub).toBe(E2E_USER_ID)

    // Same account, no longer anonymous — everything the anonymous user owned
    // is still theirs.
    const after = await storedTokens(page)
    expect(after.userId, "the account survived the sign-in").toBe(E2E_USER_ID)
    expect(after.anonymous).toBe(false)
    expect(after.email).toBe(EMAIL)
  })
})
