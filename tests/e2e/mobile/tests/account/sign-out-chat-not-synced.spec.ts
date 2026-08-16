import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../support/bootstrap.js"
import { mockSignOut } from "../../support/auth-mock.js"
import { gotoTab, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The sign-out notice has to be true, not reassuring (#1883).
 *
 * With "Sync chats" off, journaling is gated all the way down — nothing is ever
 * pushed, so the account holds no copy of the conversations — and the wipe then
 * runs `chat.clearAll()` on the only one there is. The old toast promised the
 * chats back regardless. There is deliberately no confirmation dialog (one on a
 * handed-over phone is answered by the wrong person), which makes this sentence
 * the user's only notice and its truthfulness the whole safeguard.
 */
test(qase(520, caseTitle(520)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await preseedAuthTokens(page)
  await mockSignOut(page)
  await boot(page, "en")

  await step(page, 520, 0, async () => {
    await gotoTab(page, "settings")
    const toggle = settingToggle(page, "Sync chats")
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    if ((await toggle.getAttribute("aria-checked")) !== "false") await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 10_000 })
  })

  await step(page, 520, 1, async () => {
    await page.locator("ion-item", { hasText: "E2E Tester" }).click()
    const signOut = page.getByRole("button", { name: /sign out/i })
    await expect(signOut).toBeVisible({ timeout: 10_000 })
    await signOut.click()

    const toast = page.locator("ion-toast")
    // It says the conversations were deleted…
    await expect(toast).toContainText(/deleted/i, { timeout: 20_000 })
    // …and names the downloads, which the wipe also takes and which do not
    // come back on the next sign-in — they are re-fetched.
    await expect(toast).toContainText(/downloaded lectures/i)
    // …and drops the promise it cannot keep.
    await expect(toast).not.toContainText(/chats stay in your account/i)
  })
})
