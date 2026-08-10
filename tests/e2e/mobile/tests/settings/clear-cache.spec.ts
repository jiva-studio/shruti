import fs from "fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedDismissedNags,
  preseedNonPro,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedUserDbOnce,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import {
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * "Clear cache" clears cache only — the content database survives it (#1630).
 * The unit tests assert which storage calls the action makes; what these two
 * cases assert is the property the user actually has: after clearing, the app
 * still opens, still searches and still knows which catalog it is on, without
 * re-fetching the ~54 MB file — and, on the other side, that the audio really
 * did go.
 *
 * The two halves also cover each other: 172 is what proves the action is not a
 * no-op, so 171's "the catalog is still there" can't pass because nothing
 * happened.
 *
 * The third path of #1630 — account deletion DOES drop the catalog — has no
 * case here: `resetContentDatabase` is a no-op on the web build the suite runs
 * (the IndexedDB fetcher's `list()` returns `[]`, so `pruneContentDatabases`
 * matches nothing), so on this platform the two paths are indistinguishable.
 * Tracked in #1663.
 */

/** Seeds + routes shared by both cases, minus the navigation. `userDb` is
 *  seeded ONCE so a reload is a real restart rather than a harness re-seed. */
async function seed(page: Page): Promise<void> {
  await interceptContent(page)
  await preseedUserDbOnce(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)
  await preseedOnboardingDone(page)
  await preseedNonPro(page)
}

async function launch(page: Page): Promise<void> {
  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
}

/** Run the Debug section's "Clear cache" action. The section is hidden behind
 *  the build-info unlocker (5 taps, kit default — a few extra to be safe). */
async function clearCache(page: Page): Promise<void> {
  await gotoTab(page, "settings")
  const buildInfo = page.locator(".kit-build-info")
  await buildInfo.scrollIntoViewIfNeeded()
  for (let i = 0; i < 7; i++) await buildInfo.click()
  const action = page.locator("ion-item", { hasText: "Clear cache" })
  await expect(action).toBeVisible({ timeout: 10_000 })
  await action.click()
}

/** Settings → Library → "Download limit", whose subtitle carries the live
 *  "<used> of <limit>" figure — the app's own account of what is downloaded. */
function storageInUse(page: Page): Locator {
  return page.locator("ion-item", { hasText: "Download limit" }).locator("p")
}

// Clearing the cache must not cost the catalog. A route counter over the
// catalog URL sees the cold-start download and must see nothing more: after
// the clear and a restart the app comes back up, searches the same corpus and
// still names the same content database, all from the local copy.
test(
  qase(171, caseTitle(171)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await seed(page)

    // Registered after interceptContent, so this handler is consulted first
    // and hands the request on to the fixture route it is counting.
    const catalogFetches: string[] = []
    await page.route("**/public/db/shruti.*.db", async (route) => {
      catalogFetches.push(route.request().url())
      await route.fallback()
    })

    await launch(page)

    let rowsBefore = 0
    let dbLineBefore = ""
    await step(page, 171, 0, async () => {
      await openLibrary(page)
      rowsBefore = await trackRows(page).count()
      expect(rowsBefore).toBeGreaterThan(0)

      await gotoTab(page, "settings")
      const dbLine = page.locator(".kit-build-info-db")
      await dbLine.scrollIntoViewIfNeeded()
      dbLineBefore = (await dbLine.innerText()).trim()
      expect(dbLineBefore).not.toBe("")

      // The cold start downloaded the catalog once — which is what makes the
      // count after the clear worth anything.
      expect(catalogFetches).toHaveLength(1)
    })

    await step(page, 171, 1, async () => {
      await clearCache(page)
      await expect(page.locator("ion-item", { hasText: "Clear cache" })).toBeVisible()
    })

    await step(page, 171, 2, async () => {
      await launch(page)

      await gotoTab(page, "settings")
      const dbLine = page.locator(".kit-build-info-db")
      await dbLine.scrollIntoViewIfNeeded()
      await expect(dbLine).toHaveText(dbLineBefore)

      await openLibrary(page)
      expect(await trackRows(page).count()).toBe(rowsBefore)

      // The whole point: nothing was re-downloaded. Search answered from the
      // catalog that survived the clear.
      expect(catalogFetches).toHaveLength(1)
    })
  }
)

// The other half: the cache really is cleared. A downloaded lecture's audio
// goes, the storage figure falls to zero and stays there across a restart, and
// with the network gone the app asks for the very file it used to have —
// failing the row instead of still claiming the lecture is on the device.
test(
  qase(172, caseTitle(172)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await seed(page)

    const audioFetches: string[] = []
    let allowAudio = true
    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    await page.route("**/public/tracks/*/audio/*", (route) => {
      audioFetches.push(route.request().url())
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

    await launch(page)

    let title = ""
    let cachedAudioUrl = ""
    await step(page, 172, 0, async () => {
      await openLibrary(page)
      const first = trackRows(page).first()
      title = (await first.locator(".title").innerText()).trim()
      await openTrackSheet(page, first)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()

      await expect(
        trackRows(page).filter({ hasText: title }).first().locator('[data-testid="track-state"]')
      ).toHaveAttribute("data-state", /added|completed/, { timeout: 30_000 })

      expect(audioFetches.length).toBeGreaterThan(0)
      cachedAudioUrl = audioFetches[0]

      await gotoTab(page, "settings")
      await storageInUse(page).scrollIntoViewIfNeeded()
      await expect(storageInUse(page)).toHaveText(/^[1-9][\d.,]* MB of /)
    })

    await step(page, 172, 1, async () => {
      await clearCache(page)
      await storageInUse(page).scrollIntoViewIfNeeded()
      await expect(storageInUse(page)).toHaveText(/^0 MB of /)
    })

    await step(page, 172, 2, async () => {
      // Network gone: whatever the app still has must come from the device.
      allowAudio = false
      audioFetches.length = 0
      await launch(page)

      await gotoTab(page, "settings")
      await storageInUse(page).scrollIntoViewIfNeeded()
      await expect(storageInUse(page)).toHaveText(/^0 MB of /)

      await gotoTab(page, "home")
      const queued = playlistRows(page).filter({ hasText: title }).first()
      await queued.locator("ion-item.track").click()

      // The audio is gone, so the app goes back to the network for the exact
      // file it had cached — and, with none available, the row says so.
      await expect(queued.locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        "failed",
        { timeout: 30_000 }
      )
      expect(audioFetches).toContain(cachedAudioUrl)
    })
  }
)
