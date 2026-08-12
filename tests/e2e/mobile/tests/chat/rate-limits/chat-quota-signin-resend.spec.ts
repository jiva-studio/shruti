import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { askChat, delta, done } from "../../../support/chat-mock.js"
import {
  E2E_USER_ID,
  emailIdentity,
  emailSignInModal,
  jwt,
  mockChatAuth,
  mockEmailOtpRequest,
  mockEmailOtpVerify,
  mockMe,
  submitCode,
  submitEmail,
} from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The conversion funnel itself: an anonymous user runs out of daily messages
 * and takes the banner's "Sign in" CTA. The session that comes back flips
 * `quotaId` AND `signedIn` in one `applySession`, so two identity watchers land
 * in the same Vue flush and both drove the quota re-send. Nothing latched
 * synchronously, so both entered `retryLast`, and the loser nulled the pair the
 * winner was about to swap out — the thread ended up showing the question, the
 * dead limit card, and the question again (#1779).
 */

const QUESTION = "What is the soul?"
const ANSWER = "The soul is eternal."
const EMAIL = "reader@example.com"

test(qase(304, caseTitle(304)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page, "free")

  let verified = false
  await mockMe(page, () => ({
    ok: true,
    user: verified
      ? { anonymous: false, email: EMAIL, identities: [emailIdentity(EMAIL)] }
      : { anonymous: true },
  }))
  await mockEmailOtpRequest(page)
  // The in-place upgrade the server really performs: same user row, no longer
  // anonymous, and a NEW quota bucket — which is what makes two watchers fire.
  await mockEmailOtpVerify(page, () => {
    verified = true
    return { ok: true, tokens: { accessToken: jwt({ sub: E2E_USER_ID, quotaId: "q-signed-in" }) } }
  })

  // The anonymous limit first; anything sent under the signed-in identity gets
  // a real answer, so "was the question re-sent" is observable.
  let asked = 0
  const stream = [delta(ANSWER), done()].map((f) => `${f}\n\n`).join("")
  await page.route("**/chat", (route) => {
    asked += 1
    if (asked > 1) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
    }
    return route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        detail: {
          tier: "anonymous",
          resets_at_epoch: Math.floor(Date.now() / 1000) + 3600,
          current: 3,
          limit: 3,
          key_type: "user",
        },
      }),
    })
  })

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  const notice = page.locator(".inline-notice").first()

  await step(page, 304, 0, async () => {
    await askChat(page, QUESTION)

    await expect(page.locator(".chat-inputbar textarea")).toBeDisabled({ timeout: 20_000 })
    await expect(notice).toBeVisible({ timeout: 10_000 })
    // The anonymous tier's CTA is sign-in, not the free tier's upgrade.
    await expect(notice.locator(".btn")).toHaveText("Sign in")
  })

  await step(page, 304, 1, async () => {
    await notice.locator(".btn").click()
    await page.getByRole("button", { name: "Continue with email" }).click()
    await expect(emailSignInModal(page).locator("input")).toBeVisible({ timeout: 15_000 })
    await submitEmail(page, EMAIL)
    await expect(
      emailSignInModal(page).getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await submitCode(page, "123456")
    await expect(emailSignInModal(page)).toBeHidden({ timeout: 15_000 })
  })

  await step(page, 304, 2, async () => {
    // The question is re-asked under the new entitlement and answered…
    await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 20_000 })

    // …exactly once. Three re-sends deep, the thread carried the prompt twice
    // with the dead upsell card between them.
    await expect(page.locator(".bubble-row.user")).toHaveCount(1)
    await expect(page.locator(".inline-notice")).toHaveCount(0)
  })
})
