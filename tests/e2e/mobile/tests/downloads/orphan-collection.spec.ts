import fs from "fs"
import { test, expect, type Page } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedDismissedNags,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedUserDbOnce,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import {
  deletePlaylistRow,
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  trackRows,
  trackSheet,
} from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Downloaded audio the app owes back must actually come back — including
 * across the launch that owed it.
 *
 * Archiving a lecture reclaims its file. Archiving the lecture that is playing
 * right now cannot: the engine holds a `file://` URL and deleting it out from
 * under playback strands the audio. So the delete is deferred — and until now
 * the record of the deferral lived in memory, so closing the app inside that
 * window lost it. Nothing else in the app collects orphans, so the lecture's
 * `media_items` row stayed "ready" forever: the storage budget kept charging
 * the user for space nothing was using, and refused new downloads earlier and
 * earlier (issue #1666).
 *
 * The reload is the whole point, so the user DB is seeded only when absent —
 * an unconditional preseed re-runs on every load and the "restart" would be a
 * wipe, which passes for any reason at all. The archive that CAN reclaim on
 * the spot is the control: it proves the meter moves, so a deferred reclaim
 * that never happens cannot pass as "nothing to see here".
 */

const LIMIT_ROW = "Download limit"

/** Megabytes the budget says are in use, read off the Settings row's subtitle. */
async function usedMb(page: Page): Promise<number> {
  await gotoTab(page, "settings")
  const row = page.locator("ion-item", { hasText: LIMIT_ROW }).first()
  await row.scrollIntoViewIfNeeded()
  const text = (await row.locator("p").innerText()).trim()
  const m = /^([\d.,]+)\s*(B|KB|MB|GB)/.exec(text)
  if (!m) throw new Error(`could not read storage usage from "${text}"`)
  const scale = { B: 1 / 1024 / 1024, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]!]!
  return Number(m[1]!.replace(",", ".")) * scale
}

/** Queue a library lecture and hand back its title. */
async function addLecture(page: Page, index: number): Promise<string> {
  await openLibrary(page)
  const row = trackRows(page).nth(index)
  const title = (await row.locator(".title").innerText()).trim()
  await openTrackSheet(page, row)
  await trackSheet(page).locator(".add-btn").click()
  await expect(trackSheet(page)).toBeHidden()
  return title
}

async function relaunch(page: Page): Promise<void> {
  await page.reload()
  await page.waitForURL("**/tabs/**", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
}

test(qase(191, caseTitle(191)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedOnboardingDone(page)
  await preseedUserDbOnce(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  const mp3 = fs.readFileSync(SILENT_MP3_PATH)
  await page.route("**/public/tracks/*/audio/*", (route) => {
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

  let first = ""
  let second = ""
  let twoLectures = 0
  let oneLecture = 0

  await step(page, 191, 0, async () => {
    // Two lectures on disk, both charged to the budget.
    first = await addLecture(page, 0)
    second = await addLecture(page, 1)
    await gotoTab(page, "home")
    await expect(playlistRows(page).filter({ hasText: first })).toHaveCount(1, { timeout: 20_000 })
    await expect(playlistRows(page).filter({ hasText: second })).toHaveCount(1, { timeout: 20_000 })
    await expect.poll(() => usedMb(page), { timeout: 40_000 }).toBeGreaterThan(1)
    twoLectures = await usedMb(page)
  })

  await step(page, 191, 1, async () => {
    // CONTROL: archiving a lecture nothing is holding reclaims it on the spot.
    // Without this leg the assertion below could pass on a meter that never
    // moves for any reason at all.
    await gotoTab(page, "home")
    await deletePlaylistRow(page, playlistRows(page).filter({ hasText: first }).first())
    await expect(playlistRows(page).filter({ hasText: first })).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => usedMb(page), { timeout: 30_000 }).toBeLessThan(twoLectures)
    oneLecture = await usedMb(page)
  })

  await step(page, 191, 2, async () => {
    // Now archive the lecture that is PLAYING. Its file cannot go yet, so the
    // meter holds — this is the debt the app has to carry.
    await gotoTab(page, "home")
    const row = playlistRows(page).filter({ hasText: second }).first()
    await row.locator("ion-item.track").click()
    await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/, { timeout: 20_000 })

    await deletePlaylistRow(page, row)
    await expect(playlistRows(page).filter({ hasText: second })).toHaveCount(0, { timeout: 20_000 })
    expect(await usedMb(page)).toBeCloseTo(oneLecture, 0)
  })

  await step(page, 191, 3, async () => {
    // Force-close and relaunch. The engine is gone with the process, so nothing
    // can reach the file any more and the launch settles what the previous
    // session could not. Before this, those megabytes were charged until the
    // app was uninstalled.
    await relaunch(page)
    await gotoTab(page, "home")

    await expect.poll(() => usedMb(page), { timeout: 40_000 }).toBeLessThan(oneLecture)
  })
})
