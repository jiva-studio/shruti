import fs from "fs"
import { test, expect } from "../support/test.js"
import {
  interceptContent,
  preseedSearchFilter,
  preseedDismissedNags,
  preseedUserDbOnce,
} from "../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { openLibrary, openTrackSheet, trackRows, trackSheet } from "../support/nav.js"

// A download interrupted by a force-close must not be lost. We hang the audio
// transfer so the row persists at "downloading", then reload (= force-close).
// On restart the app rehydrates the persisted row and re-drives the unfinished
// download; with the network back it now completes — no manual re-add. (Web has
// no WorkManager background resume; this is the offline-observable equivalent:
// the interrupted download is recovered and finishes on next launch.)
test(
  qase(77, "Recover an interrupted download after force-close"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    await preseedUserDbOnce(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    // A mutable-mode audio route: "hang" leaves the request pending (download
    // stuck mid-transfer); "serve" fulfils it (the retry succeeds).
    let mode: "hang" | "serve" = "hang"
    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) => {
      if (mode === "serve") {
        void route.fulfill({
          status: 200,
          contentType: "audio/mpeg",
          headers: { "content-length": String(mp3.length) },
          body: mp3,
        })
      }
      // mode === "hang": never respond — the transfer is "in progress".
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    await openLibrary(page)
    const first = trackRows(page).first()
    const title = (await first.locator(".title").innerText()).trim()
    await openTrackSheet(page, first)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    const row = () => trackRows(page).filter({ hasText: title }).first()
    // The transfer hangs → the row enters the downloading state, whose radial
    // progress replaces the icon indicator (so the testid node disappears).
    await expect(row().locator('[data-testid="track-state"]')).toHaveCount(0, {
      timeout: 30_000,
    })

    // The network comes back, then the app is force-closed and relaunched.
    mode = "serve"
    await page.reload()
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    await openLibrary(page)

    // Recovery: the persisted-but-unfinished download is re-driven on launch and
    // now completes — the row reaches a downloaded terminal state on its own.
    await expect(row().locator('[data-testid="track-state"]')).toHaveAttribute(
      "data-state",
      /added|completed/,
      { timeout: 30_000 }
    )
  }
)
