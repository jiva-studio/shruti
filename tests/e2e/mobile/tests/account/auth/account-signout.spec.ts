import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { mockSignOut } from "../../../support/auth-mock.js"
import { step, caseTitle } from "../../../support/steps.js"

// Signing out clears the session: the account row reverts from the profile name
// to the anonymous sign-in prompt.
test(
  qase(113, caseTitle(113)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await preseedAuthTokens(page)
    // Sign-out is a server round-trip — it hands the refresh token back so the
    // server can revoke it. Unmocked, that call died on the loopback sink and
    // the adapter's catch swallowed it, so the local clear below looked exactly
    // the same whether or not the request was ever made.
    const signout = await mockSignOut(page)
    await boot(page, "en", { userDb: "clean" })

    await step(page, 113, 0, async () => {
      await gotoTab(page, "settings")

      await expect(page.getByText("E2E Tester")).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 113, 1, async () => {
      await page.locator("ion-item", { hasText: "E2E Tester" }).click()

      await page.getByRole("button", { name: /sign out/i }).click()

      // The profile name is gone (back to anonymous).
      await expect(page.getByText("E2E Tester")).toBeHidden({ timeout: 15_000 })

      // And the server was actually told, with the token it needs to revoke.
      expect(signout.count, "sign-out must reach the server").toBe(1)
      expect(signout.last?.body.refreshToken).toBe("e2e-refresh")
    })
  }
)
