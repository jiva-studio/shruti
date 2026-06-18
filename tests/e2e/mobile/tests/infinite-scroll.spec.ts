import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openLibrary, trackRows } from "../support/nav.js"

// The library list pages in: scrolling to the bottom loads the next page of
// tracks (PAGE_SIZE = 50), so the visible row count grows past the first page.
test(
  qase(21, "Infinite scroll loads the next page and stops at the end"),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    const rows = trackRows(page)
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    const first = await rows.count()
    expect(first).toBeGreaterThan(0)

    // Drive the Ionic infinite-scroll by scrolling the list to the bottom.
    const content = page.locator("ion-content").last()
    for (let i = 0; i < 8; i++) {
      await content.evaluate((el: HTMLElement & { scrollToBottom?: (d: number) => Promise<void> }) =>
        el.scrollToBottom?.(0)
      )
      await page.waitForTimeout(700)
      if ((await rows.count()) > first) break
    }

    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(first)
  }
)
