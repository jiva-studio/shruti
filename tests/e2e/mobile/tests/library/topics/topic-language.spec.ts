import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * `track_topics` is language-agnostic, so a topic can hold lectures in languages
 * the user hasn't enabled. The topic detail page must list only the lectures
 * available in the library language (PR #973 / #1005): a topic opened under a
 * Russian library shows its Russian (Cyrillic) lectures; switching the library
 * to English in Settings then re-scopes the still-open detail live so no Russian
 * lecture remains (a ru-only topic collapses to empty, a mixed topic keeps only
 * its English lectures). One case demonstrating the scope via an in-app switch.
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
      // Under a Russian library the topic detail lists only Russian lectures.
      await openFirstTopic(page)

      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })

    await step(page, 45, 1, async () => {
      // Switch the library language to English in Settings. The still-open detail
      // re-scopes (CollectionView watches the library language): a ru-only topic
      // collapses to empty, a mixed topic shows only its English lectures — either
      // way NO Russian (Cyrillic) lecture is left on screen. Asserting "no Cyrillic
      // title remains" rather than an exact count keeps this drift-proof across
      // catalogs whose per-topic language coverage shifts.
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
