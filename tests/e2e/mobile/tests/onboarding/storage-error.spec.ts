import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { interceptContent, preseedCorruptUserDb, preseedNonPro } from "../../support/bootstrap.js"
import { mockAnonymous } from "../../support/auth-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A user database that will not open (Qase 220, 221).
 *
 * `services/startup.ts` swallows that failure on purpose so a bad `user.db`
 * can't take the whole bootstrap down — which makes `ready === true` with
 * `databases.user === null` a reachable state. Two things used to happen there,
 * both invisible: the router bounced every route to `/onboarding`, whose Finish
 * navigates to `/tabs/home` and back into the guard (#1724); and the
 * listening-history probe threw synchronously past its `.catch()`, aborting the
 * rest of startup and leaving the run with no session at all (#1738).
 *
 * The seam is the web persistence adapter: it reads the user DB out of
 * IndexedDB, so the harness can put something there that is not a SQLite file.
 * We deliberately do NOT seed `onboarding.completed` — an unset flag is what
 * sends startup down the probe path in the first place.
 */
test(qase(220, caseTitle(220)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedCorruptUserDb(page)
  await preseedNonPro(page)

  const screen = page.getByTestId("storage-error")

  await step(page, 220, 0, async () => {
    await page.goto("/")
    await expect(screen).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/storage-error/)
    // The underlying message is quoted, so a bug report about this is actionable.
    await expect(page.getByTestId("storage-error-reason")).not.toBeEmpty()
    // Not onboarding, and not the tab bar it would have finished into.
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
    await expect(page.locator("ion-tab-bar")).toHaveCount(0)
  })

  await step(page, 220, 1, async () => {
    await page.goto("/tabs/home")
    await expect(screen).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/storage-error/)
    await expect(page.getByTestId("onboarding-primary")).toHaveCount(0)
  })

  await step(page, 220, 2, async () => {
    await page.getByTestId("storage-error-retry").click()
    // The database is still garbage, so the honest answer is the same screen —
    // reached through a real reload, not a redirect ping-pong.
    await expect(screen).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/storage-error/)
  })
})

test(qase(221, caseTitle(221)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedCorruptUserDb(page)
  await preseedNonPro(page)
  // The suite answers /auth/anonymous by default; this one counts it.
  const anonymous = await mockAnonymous(page)

  await step(page, 221, 0, async () => {
    await page.goto("/")
    await expect(page.getByTestId("storage-error")).toBeVisible({ timeout: 30_000 })
  })

  await step(page, 221, 1, async () => {
    // `useAuthStore().restore()` is the anonymous bootstrap. It used to sit at
    // the tail of `start()`, so the probe's escaping rejection cost the entire
    // run its identity — no session, no access token, every service a 401.
    await expect.poll(() => anonymous.count, { timeout: 30_000 }).toBeGreaterThan(0)
  })
})
