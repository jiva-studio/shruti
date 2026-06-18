import fs from "fs"
import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../support/bootstrap.js"
import { CONTENT_DB_PATH } from "../support/fixtures.js"
import { playlistRows } from "../support/nav.js"

/**
 * First-launch resilience: a brand-new user whose content-DB download FAILS on
 * the first attempt must land on the Welcome error screen with a working Retry —
 * not an infinite "Downloading…" splash — and a retry must recover all the way
 * to a populated Home.
 *
 * This is the user-facing path the startup-hardening fixes feed into:
 *  - the download stall watchdog turns a *hung* transfer (which used to hang
 *    `completion` forever) into exactly this retryable error. A true 60s stall
 *    can't be asserted in a fast test, so we drive the same error path with a
 *    hard failure (`route.abort`), which is deterministic.
 *  - the user-DB migration isolation keeps a later failure from re-bricking the
 *    same screen.
 *
 * Determinism comes from a gate flag, not timing: every DB request fails while
 * `allowDb` is false, so the app is guaranteed to reach the error state; we then
 * flip the flag and tap Retry, so the next attempt is guaranteed to succeed.
 */
test(
  qase(144, "A failed content-DB download shows Retry and recovers"),
  { tag: ["@offline", "@welcome"] },
  async ({ page }) => {
    // config / audio / transcript routes + a default (always-success) DB route.
    await interceptContent(page)

    // Override the DB route with a gated one. Playwright matches the
    // last-registered route first, so this wins over interceptContent's.
    let allowDb = false
    const dbBytes = fs.readFileSync(CONTENT_DB_PATH)
    await page.route("**/public/db/shruti.*.db", (route) => {
      if (!allowDb) {
        void route.abort("failed")
        return
      }
      void route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: dbBytes,
      })
    })

    // Seed everything Home needs so the post-recovery assertion is meaningful.
    await preseedUserDb(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    await page.goto("/?locale=en")

    // The download fails → Welcome surfaces the error state with a Retry button
    // (it renders only in the error state), NOT an endless progress bar.
    const retry = page.getByRole("button", { name: "Retry" })
    await expect(retry).toBeVisible({ timeout: 30_000 })

    // Let the next attempt succeed, then retry.
    allowDb = true
    await retry.click()

    // Recovers all the way to a populated Home.
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await expect(page.locator("ion-tab-bar")).toBeVisible()
    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
  }
)
