import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { deletePlaylistRow, playlistRows } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// A "completed" row carries this icon. The Up-Next count badge EXCLUDES completed
// entries, so deleting the (seeded) completed row would leave the badge unchanged
// and the deletion would look like a no-op in the screenshot. We target the first
// NOT-completed row so both the row count and the badge visibly drop by one.
const COMPLETED_ICON = ".tabler-icon-rosette-discount-check-filled"

function countBadge(page: import("@playwright/test").Page) {
  return page.locator(".playlist-count-badge")
}
async function badgeValue(page: import("@playwright/test").Page): Promise<number> {
  const m = /(\d+)/.exec((await countBadge(page).innerText()).trim())
  return m ? Number(m[1]) : NaN
}

test(qase(18, caseTitle(18)), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await boot(page)

  let beforeRows = 0
  let beforeBadge = 0
  let targetTitle = ""

  await step(page, 18, 0, async () => {
    await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
    await expect(countBadge(page)).toBeVisible({ timeout: 20_000 })
    beforeRows = await playlistRows(page).count()
    expect(beforeRows).toBeGreaterThan(0)
    beforeBadge = await badgeValue(page)
    expect(beforeBadge).toBeGreaterThan(0)

    // Target the first NOT-completed row (its removal moves the badge too).
    const target = playlistRows(page).filter({ hasNot: page.locator(COMPLETED_ICON) }).first()
    await expect(target).toBeVisible({ timeout: 10_000 })
    targetTitle = (await target.locator(".title").innerText()).trim()
  })

  await step(page, 18, 1, async () => {
    const target = playlistRows(page).filter({ hasText: targetTitle }).first()
    await deletePlaylistRow(page, target)

    await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(beforeRows - 1)
    await expect(page.locator(".playlist-row", { hasText: targetTitle })).toHaveCount(0)
    // The count badge drops by one too — the removed row was not completed.
    await expect.poll(() => badgeValue(page), { timeout: 15_000 }).toBe(beforeBadge - 1)
  })
})
