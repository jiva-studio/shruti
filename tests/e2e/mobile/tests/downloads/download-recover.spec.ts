import fs from "fs"
import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedUserDbOnce,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// A download that does not finish — whether it FAILS outright or is INTERRUPTED
// mid-transfer — recovers and reaches a downloaded terminal state. This merges
// the two recovery paths into one multi-step case:
//
//   step 0 — the failed-download manual retry: the audio transfer aborts, the
//            row surfaces the failed (red X) state, tapping it opens the sheet
//            with "Download again", and tapping that starts a FRESH transfer
//            (any stale partial discarded) once the network is allowed through.
//   step 1 — the interrupted-download auto-recovery: with the transfer now able
//            to complete, the unfinished download is re-driven — across an app
//            force-close + relaunch (reload), the persisted row rehydrates and
//            the download finishes on its own, no manual re-add — and the row
//            reaches the downloaded/completed terminal state.
//
// Determinism comes from a mutable audio route, not timing: "abort" guarantees
// the first download fails, "serve" guarantees the retry/resume succeeds. The
// user DB is seeded only if absent so the reload is a real restart that keeps
// the runtime-written download row.
test(
  qase(76, caseTitle(76)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    await preseedUserDbOnce(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    // Mutable audio route. "abort": the transfer fails (download enters failed).
    // "serve": the transfer fulfils (retry / resume succeeds).
    let mode: "abort" | "serve" = "abort"
    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) => {
      if (mode === "serve") {
        void route.fulfill({
          status: 200,
          contentType: "audio/mpeg",
          headers: { "content-length": String(mp3.length) },
          body: mp3,
        })
        return
      }
      void route.abort("failed")
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    let title = ""
    const row = () => trackRows(page).filter({ hasText: title }).first()
    const indicator = () => row().locator('[data-testid="track-state"]')

    await step(page, 76, 0, async () => {
      await openLibrary(page)

      // Add the first lecture; its audio download fails.
      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      // The row surfaces the failed (red X) state.
      await expect(indicator()).toHaveAttribute("data-state", "failed", {
        timeout: 30_000,
      })

      // Tapping the failed row OPENS THE SHEET (it no longer retries on tap),
      // whose primary action now reads "Download again".
      await openTrackSheet(page, row())
      const primary = trackSheet(page).locator(".add-btn")
      await expect(primary).toHaveText(/Download again/)

      // Retry from the sheet: a fresh transfer starts from the beginning (any
      // stale partial discarded). Allow the transfer through and tap.
      mode = "serve"
      await primary.click()
      await expect(trackSheet(page)).toBeHidden()

      // The row leaves the failed state — a fresh download is underway.
      await expect(indicator()).not.toHaveAttribute("data-state", "failed", {
        timeout: 30_000,
      })
    })

    await step(page, 76, 1, async () => {
      // Force-close + relaunch: the unfinished/just-restarted download must not
      // be lost. On launch the persisted row rehydrates and the re-driven
      // download completes on its own — no manual re-add.
      await page.reload()
      await page.waitForURL("**/tabs/home", { timeout: 60_000 })
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await openLibrary(page)

      // The recovered download reaches the downloaded terminal state.
      await expect(indicator()).toHaveAttribute("data-state", /added|completed/, {
        timeout: 30_000,
      })
    })
  }
)
