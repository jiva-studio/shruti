import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * `track_topics` is language-agnostic, so a topic can hold lectures in languages
 * the user hasn't enabled. The topic detail page must list only the lectures
 * available in the library language (PR #973 / #1005): on a Russian library a
 * topic shows its Russian lectures (45); switching the library to English then
 * re-scopes the still-open detail so no Russian lecture remains (149).
 */

async function openFirstTopic(page: import("@playwright/test").Page): Promise<void> {
  await gotoTab(page, "search")
  const tile = page.locator(".tile-grid > *").first()
  await tile.waitFor({ state: "visible", timeout: 20_000 })
  await tile.click()
  await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
}

test(
  qase(45, caseTitle(45)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")

    await step(page, 45, 0, async () => {
      await openFirstTopic(page)

      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })
  }
)

test(
  qase(149, caseTitle(149)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Reach a (Russian-only) topic the only way it's reachable: under a Russian
    // library, where its tile is shown. It lists its Russian lectures.
    await boot(page, "en")
    await editLibraryLanguages(page, { add: /Русский/, remove: "English" })

    await step(page, 149, 0, async () => {
      await openFirstTopic(page)
      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })

      // Sanity: under the Russian library the detail shows Russian lectures.
      await expect
        .poll(async () => (await trackTitles(page)).some((t) => CYRILLIC.test(t)), { timeout: 15_000 })
        .toBe(true)
    })

    await step(page, 149, 1, async () => {
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
    })
  }
)
