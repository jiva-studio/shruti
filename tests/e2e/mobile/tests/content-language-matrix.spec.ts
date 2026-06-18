import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootDeviceLocale } from "../support/bootstrap.js"
import { gotoTab, openLibrary, searchInput, trackRows, trackTitles, CYRILLIC } from "../support/nav.js"

/**
 * Content-language vs UI-language matrix (PR #1005/#1007/#1027).
 *
 * The UI ships in 14 locales, but lectures exist in only a few content
 * languages (ru, en). A fresh install with a UI locale that has no lectures of
 * its own must still get a populated library: the device locale is REDUCED to a
 * content language we have (`reduceLocaleToContentLanguage`: ru/uk → ru;
 * everyone else → en). Here we drive the real first-launch derivation by setting
 * the browser locale (Playwright `test.use({ locale })` → `navigator.language` →
 * `Device.getLanguageCode()`), WITHOUT pre-seeding a filter — then assert the
 * library, the filters sheet and the topic tiles all come up in the reduced
 * language. The fixture catalog holds en + ru lectures (ru-only topics), so the
 * script of the rows (Cyrillic vs Latin) is the observable signal.
 */

const MATRIX = [
  { locale: "uk-UA", reduces: "ru", cyrillic: true, userDb: "ru", label: "Ukrainian → Russian" },
  { locale: "hi-IN", reduces: "en", cyrillic: false, userDb: "en", label: "Hindi → English" },
  { locale: "de-DE", reduces: "en", cyrillic: false, userDb: "en", label: "German → English" },
  { locale: "sr-RS", reduces: "en", cyrillic: false, userDb: "en", label: "Serbian → English" },
] as const

for (const c of MATRIX) {
  test.describe(`content-language · ${c.label}`, () => {
    test.use({ locale: c.locale })

    test(
      qase(35, `library · seeds a ${c.reduces}-language catalog`),
      { tag: ["@offline", "@library"] },
      async ({ page }) => {
        await bootDeviceLocale(page, c.userDb)
        await openLibrary(page)

        // Poll until the locale-derived language filter has hydrated: a populated
        // list whose every visible title is in the reduced language's script.
        await expect
          .poll(
            async () => {
              const titles = await trackTitles(page)
              return titles.length > 0 && titles.every((t) => CYRILLIC.test(t) === c.cyrillic)
            },
            { timeout: 15_000 }
          )
          .toBe(true)
      }
    )

    test(
      qase(25, "library · filters sheet opens"),
      { tag: ["@offline", "@library"] },
      async ({ page }) => {
        await bootDeviceLocale(page, c.userDb)
        await openLibrary(page)

        // The filters sheet opens (scoped to the presented overlay) — the filter
        // surface is reachable for this locale.
        await page.locator(".search-row-filter-button").click()
        await expect(page.locator("ion-modal.filters-sheet.show-modal")).toBeVisible({
          timeout: 10_000,
        })
      }
    )

    test(
      qase(22, "library · title search filters the catalog"),
      { tag: ["@offline", "@library"] },
      async ({ page }) => {
        await bootDeviceLocale(page, c.userDb)
        await openLibrary(page)

        // The (derived-language) library starts populated, and the title box is
        // wired to the result set.
        await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
        await searchInput(page).fill("zzzqqxnomatch")
        await expect(trackRows(page)).toHaveCount(0, { timeout: 15_000 })
        await searchInput(page).fill("")
        await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
      }
    )

    test(
      qase(45, "search · topic / category tiles are shown"),
      { tag: ["@offline", "@library"] },
      async ({ page }) => {
        await bootDeviceLocale(page, c.userDb)
        await gotoTab(page, "search")

        // Topics are language-agnostic categories — the landing surfaces them for
        // every locale, not just en/ru.
        await expect(page.locator(".tile-grid > *").first()).toBeVisible({ timeout: 20_000 })
      }
    )
  })
}

test.describe("content-language · multiple languages selected", () => {
  test.use({ locale: "uk-UA" })

  test(
    qase(35, "library · selecting ru + en shows both scripts"),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      // Explicit multi-language selection — the user broadened the library to
      // both content languages. The Bhagavad-gita source carries en and ru, so
      // the list must mix Cyrillic and Latin titles.
      await bootDeviceLocale(page, "ru", { filterLangs: ["ru", "en"] })
      await openLibrary(page)

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
    }
  )
})

test.describe("content-language · Ukrainian topic detail", () => {
  test.use({ locale: "uk-UA" })

  test(
    qase(45, "topic · a Ukrainian user sees the topic's Russian lectures"),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      await bootDeviceLocale(page, "ru")
      await gotoTab(page, "search")
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
    }
  )
})
