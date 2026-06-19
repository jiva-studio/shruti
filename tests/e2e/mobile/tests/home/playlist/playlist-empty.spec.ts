import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { deletePlaylistRow, playlistRows } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The "Up Next" count badge (PlaylistCountBadge → `.playlist-count-badge`).
 * It renders an icon + the bare number, so we read the trailing digits.
 */
function countBadge(page: import("@playwright/test").Page) {
  return page.locator(".playlist-count-badge")
}

async function badgeValue(page: import("@playwright/test").Page): Promise<number> {
  const text = (await countBadge(page).innerText()).trim()
  const m = /(\d+)/.exec(text)
  return m ? Number(m[1]) : NaN
}

// `queueCount` (the badge) EXCLUDES completed entries, while `.playlist-row`
// renders every entry; the fixture seeds one completed track. To make a delete
// visible in the badge we target the first NOT-completed row, which carries no
// completion icon.
const COMPLETED_ICON = ".tabler-icon-rosette-discount-check-filled"

test(
  qase(17, caseTitle(17)),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    let beforeRows = 0
    let beforeBadge = 0
    let targetTitle = ""

    await step(page, 17, 0, async () => {
      await boot(page)

      await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
      await expect(countBadge(page)).toBeVisible({ timeout: 20_000 })

      beforeRows = await playlistRows(page).count()
      expect(beforeRows).toBeGreaterThan(0)
      beforeBadge = await badgeValue(page)
      expect(beforeBadge).toBeGreaterThan(0)
      expect(beforeBadge).toBeLessThanOrEqual(beforeRows)

      // Target the first NOT-completed row so its removal drops the badge too.
      const target = playlistRows(page).filter({ hasNot: page.locator(COMPLETED_ICON) }).first()
      await expect(target).toBeVisible({ timeout: 10_000 })
      targetTitle = (await target.locator(".title").innerText()).trim()
    })

    await step(page, 17, 1, async () => {
      const target = playlistRows(page).filter({ hasText: targetTitle }).first()
      await deletePlaylistRow(page, target)

      await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(beforeRows - 1)
      // The count badge drops by one too — the removed row was not completed.
      await expect.poll(() => badgeValue(page), { timeout: 15_000 }).toBe(beforeBadge - 1)
    })
  }
)

test(
  qase(13, caseTitle(13)),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)

    // Empty state: PlaylistSection swaps in the PageSticker whose header is the
    // `home.playlistIsEmpty` string ("Playlist is empty").
    const sticker = page.locator(".page-sticker")

    await step(page, 13, 0, async () => {
      await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })

      // Drain the queue one row at a time. The fixture seeds ~9 tracks; cap the
      // loop well above that so a stuck swipe fails loudly instead of spinning.
      const MAX_ITERATIONS = 40
      let iterations = 0
      while ((await playlistRows(page).count()) > 0) {
        if (++iterations > MAX_ITERATIONS) {
          throw new Error(`delete loop exceeded ${MAX_ITERATIONS} iterations — queue never drained`)
        }
        const before = await playlistRows(page).count()
        await deletePlaylistRow(page, playlistRows(page).first())
        await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before - 1)
      }

      await expect(sticker).toBeVisible({ timeout: 15_000 })
      await expect(sticker.locator(".sticker-header")).toHaveText(/Playlist is empty/i)
    })

    await step(page, 13, 1, async () => {
      // Starter-pack chips live in the sticker footer (PlaylistStarterPacks →
      // `.suggestions .chip`). Tapping one fans out `playlist.add` and the queue
      // grows again.
      const chips = sticker.locator(".suggestions .chip")
      await expect(chips.first()).toBeVisible({ timeout: 15_000 })
      await chips.first().click()

      await expect.poll(() => playlistRows(page).count(), { timeout: 20_000 }).toBeGreaterThan(0)
    })
  }
)
