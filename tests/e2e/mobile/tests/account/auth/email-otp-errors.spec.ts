import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import {
  emailSignInModal,
  mockEmailOtpRequest,
  mockEmailOtpVerify,
  mockMe,
  openEmailSignIn,
  signInError,
  storedTokens,
  submitCode,
  submitEmail,
} from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The two refusals the server actually issues on the OTP path, and what the
 * user is left holding after each.
 *
 * Both are recoverable states, and the failure mode worth guarding is the same
 * one in each: a refusal that closes the modal, or clears the form, or drops
 * the session, makes the user start over for a mistyped digit. The modal keeps
 * its own step/busy state independently of the auth store, so nothing about
 * that is structural.
 */

const EMAIL = "reader@example.com"

// 401 from `signin/email/verify` — the code was wrong, or it expired while the
// user was reading it out of another app.
test(qase(205, caseTitle(205)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  await mockMe(page)
  await mockEmailOtpRequest(page)
  const verify = await mockEmailOtpVerify(page, { ok: false, status: 401 })

  await boot(page, "en", { userDb: "clean" })

  await step(page, 205, 0, async () => {
    await gotoTab(page, "settings")
    await openEmailSignIn(page)
    await submitEmail(page, EMAIL)

    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible({ timeout: 15_000 })
  })

  await step(page, 205, 1, async () => {
    await submitCode(page, "000000")

    await expect(signInError(page)).toHaveText("That code is invalid or has expired.", {
      timeout: 15_000,
    })
    expect(verify.count).toBe(1)
  })

  await step(page, 205, 2, async () => {
    // Still on the code step, so a second attempt is one correction away — and
    // the rejected attempt did not sign anybody in.
    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeEnabled()
    expect((await storedTokens(page)).anonymous, "no session was granted").toBe(true)
  })
})

// 429 from `signin/email/request` — a code was just sent to this address (or
// this IP burst its budget). The server also sends `Retry-After`.
test(qase(206, caseTitle(206)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  await mockMe(page)
  const requested = await mockEmailOtpRequest(page, { ok: false, status: 429, retryAfter: 60 })
  const verify = await mockEmailOtpVerify(page)

  await boot(page, "en", { userDb: "clean" })

  await step(page, 206, 0, async () => {
    await gotoTab(page, "settings")
    await openEmailSignIn(page)
    await submitEmail(page, EMAIL)

    await expect(signInError(page)).toHaveText(
      "Please wait a moment before requesting another code.",
      { timeout: 15_000 }
    )
    expect(requested.count).toBe(1)
  })

  await step(page, 206, 1, async () => {
    // The throttle is not a dead end and not a silent one: the address is still
    // in the field, "Send code" is live again, and the form did NOT advance to
    // a code step for a code that was never sent.
    const modal = emailSignInModal(page)
    await expect(modal.getByRole("button", { name: "Send code" })).toBeEnabled()
    await expect(modal.locator("input")).toHaveValue(EMAIL)
    expect(verify.count, "nothing to verify").toBe(0)
  })
})
