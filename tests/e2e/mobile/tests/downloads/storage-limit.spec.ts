import { test, expect, type Page } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * What happens at the storage limit, on both sides of it.
 *
 * A notice belongs to an interaction. The background queue hitting a wall it
 * was always going to hit is not news — that toast greeted the user on every
 * launch of a library already at the cap — so the queue says nothing and the
 * row is left alone. It carries no badge of its own either: the crossed-out
 * cloud #1681 gave it was never asked for, and is gone again (#1744).
 *
 * The deliberate tap is the other side: that one is answered, always, and the
 * answer carries the way past for that single lecture — proven by the storage
 * meter, which is the only place the granted bytes show up.
 */
const TINY_LIMIT_BYTES = 1024 * 1024 // 1 MB; fixture lectures are 27-35 MB

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

test(qase(184, caseTitle(184)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await page.addInitScript((limit) => {
    localStorage.setItem("CapacitorStorage.settings.downloadLimitBytes", String(limit))
  }, TINY_LIMIT_BYTES)
  await boot(page, "en", { userDb: "clean" })

  await step(page, 184, 0, async () => {
    // Add a lecture the budget cannot possibly fit.
    await openLibrary(page)
    await openTrackSheet(page, trackRows(page).first())
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 184, 1, async () => {
    // The queue refused it and said nothing about it...
    await gotoTab(page, "home")
    const row = playlistRows(page).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // ...and left the row looking like the queued lecture it is. No badge of
    // its own anywhere on the screen — the crossed-out cloud is gone (#1744).
    await expect(page.locator('[data-state="deferred"]')).toHaveCount(0)
    await expect(page.locator("ion-toast")).toHaveCount(0)
  })

  await step(page, 184, 2, async (capture) => {
    // A tap the user is waiting on IS answered, and the answer carries a way past.
    await playlistRows(page).first().click()
    const toast = page.locator("ion-toast")
    await expect(toast).toBeVisible({ timeout: 20_000 })
    await capture()
    await toast.getByRole("button", { name: "Download anyway" }).click()
  })

  await step(page, 184, 3, async () => {
    // The grant is spent on that one lecture, and the storage meter is where
    // that shows: the row itself starts playing on the same tap and swaps its
    // indicator for a playback radial, which says nothing about the download.
    await expect.poll(() => usedMb(page), { timeout: 60_000 }).toBeGreaterThan(0)
  })
})
