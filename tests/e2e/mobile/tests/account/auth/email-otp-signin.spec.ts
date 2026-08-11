import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import {
  emailIdentity,
  emailSignInModal,
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
 * The primary way into an account, driven the way a user drives it.
 *
 * Email OTP is the only sign-in method that is mockable end to end — Google and
 * Apple go through `@capgo/capacitor-social-login` and need a real OAuth
 * round-trip — and it is the only one available at all on the off-store build.
 * It had no spec: `EmailSignInModal` appeared in none, and neither
 * `signin/email/request` nor `signin/email/verify` had a mock, so both landed
 * on the loopback sink.
 */

const EMAIL = "reader@example.com"
const NAME = "OTP Reader"
const CODE = "123456"

test(qase(203, caseTitle(203)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  // `/auth/me` answers for whoever the session currently is: anonymous until a
  // code is verified, the reader's profile afterwards. The adapter re-reads it
  // on every token commit, so one mock has to cover both sides of the sign-in.
  let verified = false
  await mockMe(page, () => ({
    ok: true,
    user: verified
      ? { anonymous: false, email: EMAIL, name: NAME, identities: [emailIdentity(EMAIL)] }
      : {},
  }))
  const requested = await mockEmailOtpRequest(page)
  const verifiedCall = await mockEmailOtpVerify(page, () => {
    verified = true
    return { ok: true }
  })

  await boot(page, "en", { userDb: "clean" })

  await step(page, 203, 0, async () => {
    await gotoTab(page, "settings")
    await openEmailSignIn(page)

    await expect(
      emailSignInModal(page).getByText("We'll email you a one-time code — no password needed.")
    ).toBeVisible()
  })

  await step(page, 203, 1, async () => {
    await submitEmail(page, EMAIL)

    // The form advances only once the request has actually been sent, and it
    // is sent for the address that was typed.
    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    expect(requested.count, "one code request").toBe(1)
    expect(requested.last?.body.email).toBe(EMAIL)
  })

  await step(page, 203, 2, async () => {
    await submitCode(page, CODE)

    // The modal dismisses itself on success, and Settings now shows a person
    // rather than the "Sign in" call to action.
    await expect(emailSignInModal(page)).toBeHidden({ timeout: 15_000 })
    const row = page.locator("ion-item", { hasText: NAME })
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible({ timeout: 15_000 })

    expect(verifiedCall.last?.body.code, "the typed code was submitted").toBe(CODE)
    expect((await storedTokens(page)).anonymous, "the persisted session is a real account").toBe(
      false
    )
  })
})
