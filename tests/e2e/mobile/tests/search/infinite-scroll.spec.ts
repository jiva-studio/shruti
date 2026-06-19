import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The library list pages in: scrolling to the bottom loads the next page of
// tracks (PAGE_SIZE = 50), so the visible row count grows past the first page.
test(
  qase(21, caseTitle(21)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    const rows = trackRows(page)
    let first = 0

    await step(page, 21, 0, async () => {
      await expect(rows.first()).toBeVisible({ timeout: 20_000 })
      first = await rows.count()
      expect(first).toBeGreaterThan(0)
    })

    await step(page, 21, 1, async () => {
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
    })
  }
)
