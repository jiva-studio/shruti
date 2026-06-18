import fs from "fs"
import { test, expect } from "../../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../../support/nav.js"

/**
 * A failed audio download must (a) surface the red X on the row, (b) still open
 * the track sheet on tap — the row no longer silently retries — and (c) offer a
 * "Download again" button in the sheet that recovers once the transfer succeeds.
 *
 * Determinism comes from a gate flag, not timing: every audio transfer is
 * aborted while `allowAudio` is false, so the first download is guaranteed to
 * fail; we then flip the flag and tap "Download again", so the retry is
 * guaranteed to succeed. (`route.abort` drives the same `failed` state the
 * airplane-mode offline guard produces, but deterministically.)
 */
test(
  qase([31, 76], "Failed download shows red X and retries from the track sheet"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Standard offline boot routes + seed, but register a GATED audio route
    // afterwards so it wins (Playwright matches the last-registered route first).
    await interceptContent(page)
    await preseedUserDb(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    let allowAudio = false
    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) => {
      if (!allowAudio) {
        void route.abort("failed")
        return
      }
      void route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        headers: { "content-length": String(mp3.length) },
        body: mp3,
      })
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    await openLibrary(page)

    // Add the first lecture; its audio download will fail.
    const rows = trackRows(page)
    const first = rows.first()
    const title = (await first.locator(".title").innerText()).trim()
    await openTrackSheet(page, first)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    // (a) The row surfaces the failed (red X) state.
    const row = rows.filter({ hasText: title }).first()
    const indicator = row.locator('[data-testid="track-state"]')
    await expect(indicator).toHaveAttribute("data-state", "failed", {
      timeout: 30_000,
    })

    // (b) Tapping the failed row OPENS THE SHEET (it no longer retries on tap).
    await openTrackSheet(page, row)
    const primary = trackSheet(page).locator(".add-btn")
    await expect(primary).toHaveText(/Download again/)

    // (c) Retrying from the sheet recovers once the transfer is allowed through.
    allowAudio = true
    await primary.click()
    await expect(trackSheet(page)).toBeHidden()
    await expect(indicator).not.toHaveAttribute("data-state", "failed", {
      timeout: 30_000,
    })
  }
)
