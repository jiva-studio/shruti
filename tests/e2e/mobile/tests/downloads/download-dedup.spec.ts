import fs from "fs"
import { test, expect } from "../../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { SILENT_MP3_PATH } from "../../support/fixtures.js"
import { qase } from "playwright-qase-reporter"
import { playFirstQueuedTrack } from "../../support/nav.js"

// Concurrent download requests for the same track collapse to one transfer. On
// boot the playlist prefetches its queued tracks; tapping one to play while its
// prefetch is still in flight is a second, concurrent request for the same
// audio URL. The store/plugin de-dup means that URL is fetched exactly once —
// we slow every transfer to widen the race window and count requests per URL.
test(
  qase(79, "Concurrent download requests are de-duplicated"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await interceptContent(page)
    await preseedUserDb(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    const counts = new Map<string, number>()
    const mp3 = fs.readFileSync(SILENT_MP3_PATH)
    // Last-registered audio route wins: slow + counting.
    await page.route("**/public/tracks/*/audio/*", async (route) => {
      const url = new URL(route.request().url()).pathname
      counts.set(url, (counts.get(url) ?? 0) + 1)
      await new Promise((r) => setTimeout(r, 1500))
      await route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        headers: { "content-length": String(mp3.length) },
        body: mp3,
      })
    })

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

    // Play the first queued track while its prefetch is mid-flight: a second
    // concurrent demand for the same URL.
    await playFirstQueuedTrack(page)

    // Let any in-flight transfers settle, then assert the de-dup invariant: no
    // audio URL was ever fetched more than once.
    await page.waitForTimeout(3000)
    const dupes = [...counts.entries()].filter(([, n]) => n > 1)
    expect(dupes, `URLs fetched more than once: ${JSON.stringify(dupes)}`).toEqual([])
    // And at least one transfer actually happened (the played track).
    expect([...counts.values()].some((n) => n >= 1)).toBe(true)
  }
)
