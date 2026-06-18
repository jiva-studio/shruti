import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC, editLibraryLanguages } from "../support/nav.js"

/**
 * Collections must follow the selected LIBRARY content language, not the UI
 * locale. A collection is curated per language — its own name, cover and track
 * list — so loading it in the interface language while the library is set to
 * another language fetched the wrong-language track ids, which the library
 * filter then dropped, leaving the collection EMPTY (the reported bug).
 *
 * The existing `collection-language` spec boots a Russian UI on a Russian
 * library, so UI and library always agreed and the bug stayed invisible. This
 * test creates the mismatch the bug hinged on: a Russian library on an English
 * interface. The shelf card and the opened collection must both be Russian and
 * non-empty — under the bug the English-named card opened onto an empty list.
 */
test(
  qase([41, 36], "collection · follows the library language, not the interface language"),
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Interface stays English; only the library content language flips to Russian.
    await boot(page, "en")
    await editLibraryLanguages(page, { add: /Русский/, remove: "English" })

    await gotoTab(page, "search")
    const card = page.locator(".carousel-section .collection-card").first()
    await card.waitFor({ state: "visible", timeout: 20_000 })
    // The discovery shelf shows the Russian collection (library-scoped), not the
    // English one the UI locale would have selected.
    await expect(card).toContainText(CYRILLIC, { timeout: 15_000 })

    await card.click()
    await page.waitForURL("**/search/collection/**", { timeout: 10_000 })

    // The collection is non-empty (the bug emptied it) and lists Russian lectures.
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)
