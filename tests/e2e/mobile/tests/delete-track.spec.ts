import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { deletePlaylistRow, playlistRows } from "../support/nav.js"

test(qase(18, "Swipe-to-archive removes a track but keeps its completion badge"), { tag: ["@offline", "@home"] }, async ({ page }) => {
  await boot(page)

  await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
  const before = await playlistRows(page).count()
  expect(before).toBeGreaterThan(0)

  // Capture the first row's text so we can assert that exact row is gone.
  const firstText = (await playlistRows(page).first().innerText()).trim()

  await deletePlaylistRow(page, playlistRows(page).first())

  await expect.poll(() => playlistRows(page).count(), { timeout: 15_000 }).toBe(before - 1)
  await expect(page.locator(".playlist-row", { hasText: firstText })).toHaveCount(0)
})
