import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../support/nav.js"

/**
 * `track_topics` is language-agnostic, so a topic can hold lectures in languages
 * the user hasn't enabled. The topic detail page must list only the lectures
 * available in the library language (PR #973 / #1005): on a Russian library a
 * topic shows its Russian lectures; on an English library a Russian-only topic
 * shows nothing rather than surfacing lectures the user can't consume.
 */

async function openFirstTopic(page: import("@playwright/test").Page): Promise<void> {
  await gotoTab(page, "search")
  const tile = page.locator(".tile-grid > *").first()
  await tile.waitFor({ state: "visible", timeout: 20_000 })
  await tile.click()
  await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
}

test(
  qase(45, "Topic page respects the library language"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await openFirstTopic(page)

    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)

test(
  qase(45, "Topic page respects the library language"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Reach a (Russian-only) topic the only way it's reachable: under a Russian
    // library, where its tile is shown. It lists its Russian lectures.
    await boot(page, "en")
    await editLibraryLanguages(page, { add: /Русский/, remove: "English" })
    await openFirstTopic(page)
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })

    // Sanity: under the Russian library the detail shows Russian lectures.
    await expect
      .poll(async () => (await trackTitles(page)).some((t) => CYRILLIC.test(t)), { timeout: 15_000 })
      .toBe(true)

    // Switch the library back to English. The still-open detail re-scopes
    // (CollectionView watches the library language): a Russian-only topic
    // collapses to empty, a mixed topic shows only its English lectures — either
    // way NO Russian lecture is left on screen. Asserting "no Cyrillic title
    // remains" rather than an exact count keeps this drift-proof across catalogs
    // whose per-topic language coverage shifts. (A ru-only topic can't be opened
    // directly under English — its tile is filtered out — so we open under RU
    // then switch.)
    await editLibraryLanguages(page, { add: "English", remove: /Русский/ })
    await gotoTab(page, "search")
    await expect(page).toHaveURL(/\/search\/topic\//)
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.every((t) => !CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)
