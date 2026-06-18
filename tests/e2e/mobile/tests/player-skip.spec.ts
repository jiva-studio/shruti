import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openTranscript } from "../support/nav.js"

// Skip forward/back jumps playback ±15s. The skip buttons live on the floating
// player's carousel (always in the DOM); we fire their click directly and read
// the seek's effect through the transcript's highlighted "current" line — the
// same observable the seek-by-tap test (57) uses. (300s fixture audio so a
// 15s jump isn't clamped.)
test(
  qase(55, "Skip back/forward 15 seconds"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await openTranscript(page)

    const blocks = page.locator(".transcript-text [data-time-start]")
    await expect(blocks.first()).toBeVisible({ timeout: 15_000 })

    const currentStart = async () => {
      const cur = page.locator(".transcript-text [data-time-start].current").first()
      await cur.waitFor({ state: "attached", timeout: 10_000 })
      return Number(await cur.getAttribute("data-time-start"))
    }

    // Seed a known position mid-transcript by tapping a later sentence.
    const count = await blocks.count()
    let anchor = blocks.first()
    for (let i = Math.min(count - 1, 14); i >= 4; i--) {
      const s = Number(await blocks.nth(i).getAttribute("data-time-start"))
      if (s > 30_000 && s < 200_000) {
        anchor = blocks.nth(i)
        break
      }
    }
    await anchor.scrollIntoViewIfNeeded()
    await anchor.click()
    await expect(anchor).toHaveClass(/\bcurrent\b/, { timeout: 10_000 })
    const base = await currentStart()

    const skipFwd = page.locator('button.skip[aria-label="Skip forward 15 seconds"]')
    const skipBack = page.locator('button.skip[aria-label="Skip back 15 seconds"]')

    // Skip forward → the current line advances (position grew by ~15s).
    await skipFwd.dispatchEvent("click")
    await expect.poll(currentStart, { timeout: 10_000 }).toBeGreaterThan(base)
    const afterFwd = await currentStart()

    // Skip back twice → the current line moves earlier than the forward point.
    await skipBack.dispatchEvent("click")
    await skipBack.dispatchEvent("click")
    await expect.poll(currentStart, { timeout: 10_000 }).toBeLessThan(afterFwd)
  }
)
