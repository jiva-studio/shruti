import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC } from "../support/nav.js"

/**
 * `track_topics` is language-agnostic, so the topics dictionary holds topics
 * that only have lectures in languages the user hasn't enabled. The Search-
 * landing topic TILE grid must surface only topics with ≥1 lecture in the
 * selected library language(s) — otherwise a tile opens onto an empty topic
 * page (the detail already filters; the list used not to). See
 * useLibraryLandingStore: `topicIdsWithTracksIn(libraryLanguages)`.
 *
 * The observable, drift-proof invariant: every tile shown under a library is
 * *consumable* in that language — opening it lands on a populated topic whose
 * titles are in that language (titles follow the library language, PR #1008). A
 * ru-only topic must never surface as a tile under an English library. We avoid
 * asserting exact tile counts: the grid is a random sample and the catalog's
 * per-topic language coverage shifts as content is published (some catalogs have
 * en-having topics, some don't).
 */

test(
  "topic tiles · are present under a Russian library",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await gotoTab(page, "search")

    // At least one topic tile renders (the topics have Russian lectures).
    await expect
      .poll(async () => page.locator(".tile-grid > *").count(), { timeout: 20_000 })
      .toBeGreaterThan(0)
  }
)

test(
  "topic tiles · under an English library are scoped to English topics",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "search")

    // Let the persisted library-language filter hydrate (the landing can briefly
    // flash the unfiltered tile set before it does).
    await page.waitForTimeout(2500)

    const tiles = page.locator(".tile-grid > *")
    const count = await tiles.count()
    // A catalog with no en-having topics correctly shows no tiles under an
    // English library — the ru-only topics have collapsed out.
    if (count === 0) return

    // Otherwise every shown tile is en-having: opening the first lands on a
    // populated topic whose titles are English (Latin), never an empty page or a
    // Russian-only topic that leaked past the filter.
    await tiles.first().click()
    await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => !CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)
