import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootDeviceLocale } from "../support/bootstrap.js"
import { openLibrary, searchInput, trackRows, trackSheet } from "../support/nav.js"

/**
 * The TrackSheet (`ion-modal.track-sheet`) renders, for a track that has them,
 * the topic chips (`.topic-chip`) and the lecture outline (`<LectureOutline>` →
 * `.chapters > li.chapter`). We reach a known ru fixture track that carries BOTH
 * — track_2VQqmis6tnmR "Как очистить ум" (8 topics, 6 chapters) — by deriving a
 * Russian library from the device locale (NO source pin → full ru catalog) and
 * searching a distinctive title word ("очистить").
 */
test.describe("track sheet · outline + topics", () => {
  test.use({ locale: "ru-RU" })

  test(
    qase(62, "Outline / chapters navigation"),
    { tag: ["@offline", "@library"] },
    async ({ page }) => {
      await bootDeviceLocale(page, "ru")
      await openLibrary(page)

      // Narrow the catalog to the target lecture by a distinctive title word, then
      // tap the row that surfaces with that title.
      await searchInput(page).fill("очистить")
      const row = trackRows(page).filter({ hasText: "очистить" }).first()
      await expect(row).toBeVisible({ timeout: 20_000 })
      await row.click()

      // Wait for the modal to actually present (`.show-modal` is added once the
      // open transition has run), then for its body to settle.
      const sheet = trackSheet(page)
      await expect(sheet).toHaveClass(/show-modal/, { timeout: 20_000 })
      await expect(sheet.locator(".sheet-actions")).toBeVisible()

      // Topic chips render (includes a possible `.topic-chip.more` overflow tag).
      await expect(sheet.locator(".topic-chip").first()).toBeVisible({ timeout: 20_000 })
      expect(await sheet.locator(".topic-chip").count()).toBeGreaterThan(0)

      // The lecture outline renders one row per chapter.
      const chapters = sheet.locator(".chapters > li.chapter")
      await expect(chapters.first()).toBeVisible({ timeout: 20_000 })
      expect(await chapters.count()).toBeGreaterThan(0)
    }
  )
})
