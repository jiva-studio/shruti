import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openLibrary, trackTitles, CYRILLIC } from "../support/nav.js"

/**
 * The library content language (a persisted facet, distinct from the UI
 * language) is the single source of truth for which lectures the catalog shows
 * (PR #1005). On first launch it is seeded from the device locale, reduced to a
 * content language we actually have (ru/en) — so the list is never empty and
 * never mixes a language the user didn't ask for. Title text follows the library
 * language too (PR #1008), so the script of the rows is the observable signal.
 *
 * The fixture catalog holds lectures in en and ru; the Bhagavad-gita source the
 * bootstrap pins has both, so each locale yields a full, single-script list.
 */

test(
  qase(35, "library · a Russian locale seeds a Russian-language catalog"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await openLibrary(page)

    // Poll until the persisted language filter has hydrated and settled: a
    // populated list whose every visible title is Cyrillic.
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)

test(
  qase(35, "library · an English locale seeds an English-language catalog"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en")
    await openLibrary(page)

    // No Russian lectures leak onto an English library once the filter settles.
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => !CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)
