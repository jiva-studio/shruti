import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot, preseedAuthTokens } from "../../support/bootstrap.js"
import { mockSignOut } from "../../support/auth-mock.js"
import { gotoTab, openLibrary, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Signing out has to leave the device clean for whoever picks up the phone
 * next (#1773). The user DB is device-wide — one `user.db`, no account in its
 * path — so before the fix the previous account's notes were still listed to
 * the next person. The wipe is silent by design; the toast is the only notice.
 */
test(qase(286, caseTitle(286)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await preseedAuthTokens(page)
  await mockSignOut(page)
  await boot(page, "en")

  const notes = page.locator(".note[role=button]")

  await step(page, 286, 0, async () => {
    await gotoTab(page, "notes")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    expect(await notes.count()).toBeGreaterThan(0)
  })

  await step(page, 286, 1, async () => {
    await gotoTab(page, "settings")
    await page.locator("ion-item", { hasText: "E2E Tester" }).click()

    const signOut = page.getByRole("button", { name: /sign out/i })
    await expect(signOut).toBeVisible({ timeout: 10_000 })
    await signOut.click()

    // No confirmation dialog stands between the tap and the wipe — the next
    // thing on screen is the toast saying where the data went.
    await expect(page.locator("ion-toast")).toContainText(/stay in your account/i, {
      timeout: 20_000,
    })
  })

  await step(page, 286, 2, async () => {
    await gotoTab(page, "notes")
    await expect.poll(() => notes.count(), { timeout: 20_000 }).toBe(0)

    // …and the public lecture catalog is still there. It is byte-identical for
    // every user and holds nothing personal, so the wipe spares it rather than
    // billing the next person a ~54 MB re-download — which a search that still
    // finds lectures is the user-visible proof of.
    await openLibrary(page)
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
  })
})
