import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

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
 * per-topic language coverage shifts as content is published. One case
 * demonstrating the scope via an in-app switch: tiles render under a Russian
 * library, then after flipping the library language to English in Settings the
 * grid settles to only English-consumable topics (possibly none) — never a
 * ru-only topic that leaked past the filter.
 */
test(
  qase(150, caseTitle(150)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")

    await step(page, 150, 0, async () => {
      // cases.json holds one step for case 150, so the ru assertion, the in-app
      // language switch, and the en scoping check all live in this step.

      // Under a Russian library at least one topic tile renders (the topics have
      // Russian lectures).
      await gotoTab(page, "search")
      await expect
        .poll(async () => page.locator(".tile-grid > *").count(), { timeout: 20_000 })
        .toBeGreaterThan(0)

      // Flip the library content language to English in Settings, then return to
      // the Search landing and let the filter hydrate (the landing can briefly
      // flash the unfiltered tile set before it does).
      await editLibraryLanguages(page, { add: "English", remove: /Русский/ })
      await gotoTab(page, "search")
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
    })
  }
)
