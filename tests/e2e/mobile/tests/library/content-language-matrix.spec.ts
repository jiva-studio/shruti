import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootDeviceLocale } from "../../support/bootstrap.js"
import { gotoTab, openLibrary, searchInput, trackRows, trackTitles, CYRILLIC } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Content-language vs UI-language matrix (PR #1005/#1007/#1027).
 *
 * The UI ships in 14 locales, but lectures exist in only a few content
 * languages (ru, en). A fresh install with a UI locale that has no lectures of
 * its own must still get a populated library: the device locale is REDUCED to a
 * content language we have (`reduceLocaleToContentLanguage`: ru/uk → ru;
 * everyone else → en). We drive the real first-launch derivation by setting the
 * browser locale (Playwright `test.use({ locale })` → `navigator.language` →
 * `Device.getLanguageCode()`), WITHOUT pre-seeding a filter.
 *
 * One CASE per locale (the device locale is fixed per test, so each locale must
 * be its own test/result). Within a locale the four surfaces — library, filters,
 * search, topics — are the four STEPS, so each gets its own screenshot in the
 * run. The fixture catalog holds en + ru lectures (ru-only topics), so the script
 * of the rows (Cyrillic vs Latin) is the observable signal.
 */

const MATRIX = [
  { id: 158, locale: "uk-UA", cyrillic: true, userDb: "ru", label: "Ukrainian → Russian" },
  { id: 159, locale: "hi-IN", cyrillic: false, userDb: "en", label: "Hindi → English" },
  { id: 160, locale: "de-DE", cyrillic: false, userDb: "en", label: "German → English" },
  { id: 161, locale: "sr-RS", cyrillic: false, userDb: "en", label: "Serbian → English" },
] as const

for (const c of MATRIX) {
  test.describe(`content-language · ${c.label}`, () => {
    test.use({ locale: c.locale })

    test(
      qase(c.id, caseTitle(c.id)),
      { tag: ["@offline", "@library"] },
      async ({ page }) => {
        await bootDeviceLocale(page, c.userDb)

        await step(page, c.id, 0, async () => {
          // Library: poll until the locale-derived language filter has hydrated —
          // a populated list whose every visible title is in the reduced script.
          await openLibrary(page)
          await expect
            .poll(
              async () => {
                const titles = await trackTitles(page)
                return titles.length > 0 && titles.every((t) => CYRILLIC.test(t) === c.cyrillic)
              },
              { timeout: 15_000 }
            )
            .toBe(true)
        })

        await step(page, c.id, 1, async () => {
          // Filters: the sheet opens (scoped to the presented overlay).
          await page.locator(".search-row-filter-button").click()
          await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({ timeout: 10_000 })
          // Dismiss so the next step acts on the library, not the overlay.
          await page.keyboard.press("Escape")
          await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeHidden({ timeout: 10_000 })
        })

        await step(page, c.id, 2, async () => {
          // Search is wired to the derived result set: a no-match empties it,
          // clearing restores it.
          await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
          await searchInput(page).fill("zzzqqxnomatch")
          await expect(trackRows(page)).toHaveCount(0, { timeout: 15_000 })
          await searchInput(page).fill("")
          await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
        })

        await step(page, c.id, 3, async () => {
          // Topics: the landing tile grid surfaces topics for this locale.
          await gotoTab(page, "search")
          await expect(page.locator(".tile-grid > *").first()).toBeVisible({ timeout: 20_000 })
        })
      }
    )
  })
}

test.describe("content-language · multiple languages selected", () => {
  test.use({ locale: "uk-UA" })

  test(
    qase(162, caseTitle(162)),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      // Explicit multi-language selection — the user broadened the library to
      // both content languages. The Bhagavad-gita source carries en and ru, so
      // the list must mix Cyrillic and Latin titles.
      await bootDeviceLocale(page, "ru", { filterLangs: ["ru", "en"] })
      await openLibrary(page)

      await step(page, 162, 0, async () => {
        await expect
          .poll(
            async () => {
              const titles = await trackTitles(page)
              const hasCyrillic = titles.some((t) => CYRILLIC.test(t))
              const hasLatin = titles.some((t) => !CYRILLIC.test(t) && /[A-Za-z]/.test(t))
              return titles.length > 0 && hasCyrillic && hasLatin
            },
            { timeout: 15_000 }
          )
          .toBe(true)
      })
    }
  )
})

test.describe("content-language · Ukrainian topic detail", () => {
  test.use({ locale: "uk-UA" })

  test(
    qase(163, caseTitle(163)),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      await bootDeviceLocale(page, "ru")
      await gotoTab(page, "search")

      await step(page, 163, 0, async () => {
        const tile = page.locator(".tile-grid > *").first()
        await tile.waitFor({ state: "visible", timeout: 20_000 })
        await tile.click()
        await page.waitForURL("**/search/topic/**", { timeout: 10_000 })

        await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
        await expect
          .poll(
            async () => {
              const titles = await trackTitles(page)
              return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
            },
            { timeout: 15_000 }
          )
          .toBe(true)
      })
    }
  )
})
