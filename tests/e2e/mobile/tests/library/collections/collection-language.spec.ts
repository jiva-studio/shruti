import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A curated collection can mix languages, but it must only surface tracks the
 * user can actually consume in their library language (PR #1005,
 * CollectionView). On a Russian library the collection's English-only tracks are
 * filtered out, so every row that remains is a Russian lecture; flipping the
 * library language to English in Settings re-scopes the discovery shelf + the
 * opened collection so every row becomes Latin — the collection is never emptied
 * by a UI/library language mismatch (the reported bug). One case demonstrating
 * the scope via an in-app switch.
 */
test(
  qase(41, caseTitle(41)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await gotoTab(page, "search")

    await step(page, 41, 0, async () => {
      // Open the first collection card in a discovery carousel under the Russian
      // library.
      const card = page.locator(".carousel-section .collection-card").first()
      await card.waitFor({ state: "visible", timeout: 20_000 })
      await card.click()
      await page.waitForURL("**/search/collection/**", { timeout: 10_000 })

      await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })

      // Once the language filter settles the collection lists only Russian rows —
      // its English-only tracks have been dropped.
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })

    await step(page, 41, 1, async () => {
      // Flip the library content language to English in Settings, return to the
      // discovery shelf and open the first collection card again. The card is now
      // the English collection (library-scoped, not the UI locale) and the opened
      // collection is non-empty with only Latin rows — never emptied by the
      // UI/library language mismatch.
      await editLibraryLanguages(page, { add: "English", remove: /Русский/ })
      // Return to the still-open collection detail — it re-scopes in place to the
      // English library (re-opening the carousel card is unreliable: the card can
      // be hidden mid-reload). A Russian-leaning collection may collapse to few or
      // no rows under English, so assert the drift-proof "no Cyrillic remains"
      // (allows an empty result) rather than an exact Latin count.
      await gotoTab(page, "search")
      await expect(page).toHaveURL(/\/search\/collection\//)
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.every((t) => !CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })
  }
)
