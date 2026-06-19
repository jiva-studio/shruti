import fs from "fs"
import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedUserDbOnce,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import {
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/** Standard offline routes + seed, but with a GATED audio route the test owns
 *  (registered last so it wins). `allow` toggles network availability. */
async function bootGatedAudio(page: import("@playwright/test").Page): Promise<{
  allow: (v: boolean) => void
}> {
  await interceptContent(page)
  await preseedUserDb(page, "en")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  let allowAudio = true
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
  return { allow: (v: boolean) => (allowAudio = v) }
}

// Adding a library track downloads its audio and reaches a downloaded
// ("added"/"completed") terminal state — then that state survives an app
// restart, rehydrating from the persisted user DB + cached blob with NO
// re-download. The user DB is seeded ONCE (only if absent) so the reload is a
// real restart, not a harness re-seed that would clobber the runtime download
// row. A gated audio route makes the first download succeed but FAILS every
// audio fetch after the restart — so a passing post-restart row proves the
// state rehydrated locally rather than silently re-downloading.
test(
  qase(74, caseTitle(74)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    // Seed the user DB only if absent, so a reload (= restart) keeps the
    // runtime-written media_items instead of clobbering them with the fixture.
    await preseedUserDbOnce(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    let allowAudio = true
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

    let title = ""
    const row = () => trackRows(page).filter({ hasText: title }).first()

    await step(page, 74, 0, async () => {
      await openLibrary(page)

      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      // The audio download reaches a downloaded terminal state.
      await expect(row().locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })

    await step(page, 74, 1, async () => {
      // Kill the network before restarting: any further audio fetch fails, so a
      // surviving downloaded row can only come from the persisted DB + cache.
      allowAudio = false

      // Restart.
      await page.reload()
      await page.waitForURL("**/tabs/home", { timeout: 60_000 })
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await openLibrary(page)

      // The downloaded state rehydrated — still added, no re-download needed.
      await expect(row().locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })
  }
)

// A downloaded track plays with the network gone: playback reads the cached
// blob, so the player goes live even though every audio fetch now fails.
test(
  qase(80, caseTitle(80)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    const { allow } = await bootGatedAudio(page)

    let title = ""
    await step(page, 80, 0, async () => {
      await openLibrary(page)

      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      const libRow = trackRows(page).filter({ hasText: title }).first()
      await expect(libRow.locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|completed/,
        { timeout: 30_000 }
      )
    })

    await step(page, 80, 1, async () => {
      // Network is gone — every further audio fetch fails.
      allow(false)

      // Play the now-cached track from the Home queue. The player must go live
      // from the cached blob, not the (now-dead) network.
      await gotoTab(page, "home")
      const queued = playlistRows(page).filter({ hasText: title }).first()
      await queued.locator("ion-item.track").click()
      await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/, { timeout: 20_000 })
    })
  }
)
