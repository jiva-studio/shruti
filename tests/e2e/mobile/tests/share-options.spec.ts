import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { openLibrary, trackRows } from "../support/nav.js"
import type { Locator, Page } from "@playwright/test"

// Local mirror of nav.ts helpers (imports are restricted to
// gotoTab/openLibrary/trackRows/playlistRows for this spec).
function trackSheet(page: Page): Locator {
  return page.locator("ion-modal.track-sheet")
}

async function openTrackSheet(page: Page, row: Locator): Promise<void> {
  await row.click()
  const sheet = trackSheet(page)
  await expect(sheet).toBeVisible()
  await expect(sheet.locator(".sheet-actions")).toBeVisible()
}

// Labels come from i18n locales/en/search.ts → search.share.*
//   pdf:   "Transcript (PDF)"
//   text:  "Transcript (text)"
//   audio: "Audio"
test(
  "library · share menu lists text and audio options",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page)
    await openLibrary(page)
    await openTrackSheet(page, trackRows(page).first())

    await trackSheet(page).locator(".share-btn").click()

    // Dev/web build is treated as subscribed → Share opens the export
    // action sheet (PDF / text / audio) rather than the paywall.
    const sheet = page.locator("ion-action-sheet")
    await expect(sheet).toBeVisible({ timeout: 15_000 })

    // PDF entry point (mirrors share-menu.spec.ts) plus the two extra
    // options. Match by rendered i18n label, not by index. Audio is
    // enabled because the seeded track variant has the silent-MP3 stub.
    const pdfOption = sheet.getByRole("button", { name: /transcript \(pdf\)/i })
    const textOption = sheet.getByRole("button", { name: /transcript \(text\)/i })
    const audioOption = sheet.getByRole("button", { name: /^audio$/i })

    await expect(pdfOption).toBeVisible()
    await expect(textOption).toBeVisible()
    await expect(audioOption).toBeVisible()
  }
)
