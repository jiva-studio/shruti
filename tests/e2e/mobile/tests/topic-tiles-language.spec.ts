import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

/**
 * `track_topics` is language-agnostic, so the topics dictionary holds topics
 * that only have lectures in languages the user hasn't enabled. The Search-
 * landing topic TILE grid must surface only topics with ≥1 lecture in the
 * selected library language(s) — otherwise a tile opens onto an empty topic
 * page (the detail already filters; the list used not to). See
 * useLibraryLandingStore: `topicIdsWithTracksIn(libraryLanguages)`.
 *
 * The fixture has en+ru lectures but its topics carry RUSSIAN-only lectures, so:
 *  - a Russian library shows topic tiles, but
 *  - an English library shows none (every fixture topic is ru-only).
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
  "topic tiles · with no English lectures are hidden under an English library",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "search")

    // The landing may flash the unfiltered tile set before the persisted
    // library-language filter hydrates; settle, then assert the ru-only topics
    // have collapsed out — the grid resolves to zero tiles (or is absent).
    await page.waitForTimeout(2500)
    await expect(page.locator(".tile-grid > *")).toHaveCount(0)
  }
)
