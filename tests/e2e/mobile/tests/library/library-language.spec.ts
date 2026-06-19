import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, gotoTab, trackTitles, CYRILLIC, editLibraryLanguages } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The library content language (a persisted facet, distinct from the UI
 * language) is the single source of truth for which lectures the catalog shows
 * (PR #1005). On first launch it is seeded from the device locale, reduced to a
 * content language we actually have (ru/en) — so the list is never empty and
 * never mixes a language the user didn't ask for. Title text follows the library
 * language too (PR #1008), so the script of the rows is the observable signal.
 *
 * The fixture catalog holds lectures in en and ru; the Bhagavad-gita source the
 * bootstrap pins has both, so each language yields a full, single-script list.
 * One case demonstrating the scope via an in-app switch: open the library under
 * a Russian library (every row Cyrillic), then flip the library language to
 * English in Settings, reopen, and every row is Latin — no Russian lecture
 * leaks in.
 */
test(
  qase(35, caseTitle(35)),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await openLibrary(page)

    await step(page, 35, 0, async () => {
      // cases.json holds one step for case 35, so the ru assertion, the in-app
      // language switch, and the en assertion all live in this step.

      // Under a Russian library every visible title is Cyrillic (poll until the
      // persisted language filter has hydrated and settled).
      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)

      // Flip the library content language to English in Settings, then reopen the
      // library. The list re-scopes — every visible title is Latin, no Cyrillic
      // (Russian) title leaks in.
      await editLibraryLanguages(page, { add: "English", remove: /Русский/ })
      // The all-lectures list re-scopes live to the English library (the search
      // filters now mirror the library language from the store), so just return to
      // the search tab — no remount needed.
      await gotoTab(page, "search")

      await expect
        .poll(async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.every((t) => !CYRILLIC.test(t))
        }, { timeout: 15_000 })
        .toBe(true)
    })
  }
)
