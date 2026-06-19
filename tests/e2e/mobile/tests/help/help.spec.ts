import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, CYRILLIC } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

const helpDialog = (page: import("@playwright/test").Page) => page.locator("ion-modal.help-dialog")

test(
  qase(123, caseTitle(123)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "clean" })
    await gotoTab(page, "settings")

    const dialog = helpDialog(page)

    // step 0 — open the Help dialog → its table of contents is shown.
    await step(page, 123, 0, async () => {
      await page.locator("ion-item", { hasText: "Open help" }).click()

      await expect(dialog).toBeVisible({ timeout: 10_000 })
      // The TOC lists help pages (category headers + page rows).
      await expect(dialog.locator("ion-list ion-item").first()).toBeVisible({ timeout: 10_000 })
    })

    // step 1 — open a help page → its markdown body renders.
    await step(page, 123, 1, async () => {
      // Open the first help page from the TOC.
      await dialog.locator("ion-list ion-item").first().click()

      // The markdown body renders.
      await expect(dialog.locator(".help-md")).toBeVisible({ timeout: 10_000 })
    })

    // step 2 — go back → the table of contents is shown again, then the dialog
    // closes cleanly. (Folds the original 123 "close" assertion in here so no
    // assertion from the source cases is lost.)
    await step(page, 123, 2, async () => {
      await dialog.getByRole("button", { name: /back/i }).click()
      await expect(dialog.locator(".help-md")).toBeHidden({ timeout: 10_000 })
      await expect(dialog.locator("ion-list ion-item").first()).toBeVisible({ timeout: 10_000 })

      // Closes cleanly (original case 123 assertion).
      await dialog.getByRole("button", { name: /close/i }).click()
      await expect(dialog).toBeHidden({ timeout: 10_000 })
    })

    // step 3 — (language) under a Russian app/library the TOC text is Cyrillic.
    // Steps 0-2 exercise the English UI (the "Open help" item and the Back
    // button are matched by their English labels, and the en help pages render).
    // The Cyrillic-TOC check needs a Russian boot, which a single boot() can't
    // share with the English steps above — so this step re-boots the app in ru,
    // re-opens the dialog and asserts the localized TOC. boot() re-navigates with
    // a fresh ?locale and re-seeds the ru user.db, so the last boot wins.
    await step(page, 123, 3, async () => {
      await boot(page, "ru", { userDb: "clean" })
      await gotoTab(page, "settings")

      const ruDialog = helpDialog(page)
      await page.locator("ion-item", { hasText: "Открыть справку" }).click()
      await expect(ruDialog).toBeVisible({ timeout: 10_000 })

      // The TOC page titles are localized → Cyrillic under a Russian UI.
      const tocText = await ruDialog.locator("ion-list").innerText()
      expect(CYRILLIC.test(tocText)).toBe(true)
    })
  }
)
