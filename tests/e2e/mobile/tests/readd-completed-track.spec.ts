import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import {
  deletePlaylistRow,
  gotoTab,
  openLibrary,
  openTrackSheet,
  playlistRows,
  searchInput,
  trackRows,
  trackSheet,
} from "../support/nav.js"

/**
 * The completed "double-check" indicator (IconRosetteDiscountCheckFilled →
 * Tabler renders `svg.tabler-icon-rosette-discount-check-filled`). "added" is a
 * different icon (`circle-check-filled`) and "queued" is a radial, so the
 * presence/absence of this exact class cleanly separates "completed" from a
 * fresh playlist row.
 */
const COMPLETED_ICON = ".tabler-icon-rosette-discount-check-filled"

/**
 * The English fixture's only track whose LATEST listening session reaches the
 * end — "Kṛṣṇa the Original Person and Source of All Incarnations"
 * (track_0AphX6MLtwU9) — so it's the deterministic "completed" entry. We boot
 * with no source filter (full catalog) so it's also reachable in the library
 * for re-adding. Match an ASCII slice of the title to dodge diacritics.
 */
const COMPLETED_TITLE = "Original Person and Source"

/**
 * Regression guard for SHRUTI-18/19: archiving a completed track keeps its
 * lifetime "listened" badge in the library, but re-adding it must start a FRESH
 * pass in the playlist — the queue row must NOT carry the old "completed"
 * indicator (the bug showed it at 100% / double-check on re-add), while the
 * library keeps the badge.
 */
test(
  "home · re-adding a completed+archived track resets queue progress, library keeps the badge",
  { tag: ["@offline", "@home"] },
  async ({ page }) => {
    await boot(page, "en", { sourceIds: [] })

    // The completed track shows the double-check badge in the queue.
    const queueRow = playlistRows(page).filter({ hasText: COMPLETED_TITLE })
    await expect(queueRow.first()).toBeVisible({ timeout: 20_000 })
    await expect(queueRow.first().locator(COMPLETED_ICON)).toBeVisible()

    // Archive it — it leaves the active queue.
    await deletePlaylistRow(page, queueRow.first())
    await expect(playlistRows(page).filter({ hasText: COMPLETED_TITLE })).toHaveCount(0, {
      timeout: 15_000,
    })

    // In the library the completed badge survives the archive.
    await openLibrary(page)
    await searchInput(page).fill(COMPLETED_TITLE)
    const libRow = trackRows(page).filter({ hasText: COMPLETED_TITLE })
    await expect(libRow.first()).toBeVisible({ timeout: 15_000 })
    await expect(libRow.first().locator(COMPLETED_ICON)).toBeVisible()

    // Re-add it from the library detail sheet.
    await openTrackSheet(page, libRow.first())
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()

    // Back on Home: the re-added queue row is a FRESH pass — no completed
    // double-check (and so no 100% radial). This is the bug being guarded.
    await gotoTab(page, "home")
    const readded = playlistRows(page).filter({ hasText: COMPLETED_TITLE })
    await expect(readded.first()).toBeVisible({ timeout: 20_000 })
    await expect(readded.first().locator(COMPLETED_ICON)).toHaveCount(0)

    // …while the library still shows the lifetime completion badge. The search
    // tab kept its `/tabs/search/tracks` stack, so return to it directly rather
    // than re-running openLibrary (whose "All lectures" entry point is gone).
    await gotoTab(page, "search")
    await searchInput(page).fill(COMPLETED_TITLE)
    const libRow2 = trackRows(page).filter({ hasText: COMPLETED_TITLE })
    await expect(libRow2.first()).toBeVisible({ timeout: 15_000 })
    await expect(libRow2.first().locator(COMPLETED_ICON)).toBeVisible()
  }
)
