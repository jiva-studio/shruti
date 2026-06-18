import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openLibrary, searchInput, trackRows, trackTitles } from "../support/nav.js"

// A dotted verse reference matches the exact verse, not a prefix: searching
// "bg 1.1" must not bleed into 1.10 / 1.11.
test(
  qase(23, "Verse-reference search matches the exact reference (no prefix bleed)"),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)

    await searchInput(page).fill("bg 1.1")
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })

    // No visible result references 1.10–1.19 (a prefix would bleed into them).
    await expect
      .poll(async () => (await trackTitles(page)).some((t) => /\b1\.1[0-9]\b/.test(t)), {
        timeout: 10_000,
      })
      .toBe(false)
  }
)
