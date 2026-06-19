import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import {
  gotoTab,
  trackRows,
  trackTitles,
  CYRILLIC,
  libraryLanguageRow,
  libraryLanguageDialog,
} from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Settings → Library hosts the library-language picker (PR #1006): a single row
 * that opens a multi-select checkbox dialog over the CONTENT languages the
 * catalog has (not the full UI-language list), editing the same persisted set
 * the search facet uses. Picking a language re-filters every discovery surface,
 * and the chosen language drives the displayed content too — independently of
 * the UI language (PR #1008).
 */

test(
  qase(116, caseTitle(116)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "settings")

    const dialog = libraryLanguageDialog(page)
    await step(page, 116, 0, async () => {
      // The row summarises the current pick (English on a fresh English install).
      await expect(libraryLanguageRow(page)).toContainText("English")
      await libraryLanguageRow(page).click()

      const boxes = dialog.locator("ion-checkbox")
      await expect(boxes.first()).toBeVisible({ timeout: 10_000 })
      // Exactly the languages the catalog actually has lectures in — en + ru —
      // not the long list of UI languages the interface ships in.
      await expect(boxes).toHaveCount(2)
      await expect(dialog.locator("ion-checkbox", { hasText: "English" })).toBeVisible()
    })

    await step(page, 116, 1, async () => {
      // Add Russian and apply.
      await dialog.locator("ion-checkbox", { hasText: /Русский/ }).click()
      await dialog.getByRole("button", { name: /apply|примен/i }).click()

      // The selection is persisted and reflected back in the row subtitle.
      await expect(libraryLanguageRow(page)).toContainText("English")
      await expect(libraryLanguageRow(page)).toContainText("Русский")
    })
  }
)

test(
  qase(36, caseTitle(36)),
  { tag: ["@offline", "@settings", "@library"] },
  async ({ page }) => {
    // English UI + English library: the fixture's topics hold only Russian
    // lectures, so they have nothing to show yet.
    await boot(page, "en")
    await gotoTab(page, "settings")

    await step(page, 36, 0, async () => {
      // Switch the library to Russian only (add ru, then drop en).
      await libraryLanguageRow(page).click()
      const dialog = libraryLanguageDialog(page)
      await expect(dialog.locator("ion-checkbox", { hasText: "English" })).toBeVisible({
        timeout: 10_000,
      })
      await dialog.locator("ion-checkbox", { hasText: /Русский/ }).click()
      await dialog.locator("ion-checkbox", { hasText: "English" }).click()
      await dialog.getByRole("button", { name: /apply|примен/i }).click()

      // The UI stays English (the row keeps its English label) while the library
      // is now Russian (its subtitle) — language selection is decoupled from the UI.
      await expect(libraryLanguageRow(page)).toContainText("Lecture languages")
      await expect(libraryLanguageRow(page)).toContainText("Русский")
    })

    await step(page, 36, 1, async () => {
      // A topic now lists lectures, and — because content follows the library
      // language (PR #1008) — their titles are Russian even though the UI is English.
      await gotoTab(page, "search")
      const tile = page.locator(".tile-grid > *").first()
      await tile.waitFor({ state: "visible", timeout: 20_000 })
      await tile.click()
      await page.waitForURL("**/search/topic/**", { timeout: 10_000 })

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
