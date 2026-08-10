import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
  preseedNonPro,
  preseedOnboardingDone,
} from "../../support/bootstrap.js"
import { appLanguageRow, gotoTab, localeChunkUrl } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The boot locale's message bundle is a lazily-imported chunk for every
 * language except English, which the entry chunk carries statically. Startup
 * awaits that chunk between `router.isReady()` and `app.mount()`, so a chunk
 * that 404s (hashes rotated by a web deploy) or dies on a flaky radio used to
 * abort startup outright: the mount never ran and the native splash dismissed
 * onto an empty WebView, with no retry and no error screen (issue #1605).
 *
 * Aborting `bundles/ru.ts` on a Russian device reproduces exactly that. The
 * guarantee is that the app still comes up and is usable — in the resident
 * English fallback, never as raw keys and never as nothing.
 */
test(qase(168, caseTitle(168)), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await interceptContent(page)
  await page.route(localeChunkUrl("ru"), (route) => void route.abort("failed"))
  await preseedUserDb(page, "ru", "clean")
  await preseedSearchFilter(page, "ru")
  await preseedDismissedNags(page)
  await preseedOnboardingDone(page)
  await preseedNonPro(page)

  await step(page, 168, 0, async () => {
    await page.goto("/?locale=ru")

    // The route replace happens BEFORE the awaited chunk, so the URL alone
    // proves nothing — the rendered tab bar is what says the mount ran.
    await expect(page.locator("ion-tab-bar").first()).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/tabs\/home/)
  })

  await step(page, 168, 1, async () => {
    // Usable, not merely mounted: navigate and read a real translated string.
    await gotoTab(page, "settings")
    await expect(appLanguageRow(page).first()).toBeVisible({ timeout: 20_000 })
  })
})
