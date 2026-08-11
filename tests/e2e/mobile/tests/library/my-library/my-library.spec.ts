import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, searchInput } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"

// `MyLibraryView` and the shelf that leads to it, offline. The rows come down
// the way the real ones do — `library_items` is server-owned and pull-only, so
// the ingest mock hands them to the app as a profile-sync page rather than
// writing them into the fixture db.

const READY = {
  id: "lib-ready",
  status: "ready" as const,
  title_raw: "Surrender in Bhagavad-gita",
  author_raw: "Test Speaker",
  track_id: "hash-e2e-ready",
}

const PROCESSING = {
  id: "lib-processing",
  status: "processing" as const,
  title_raw: "A morning walk in Vrindavan",
  author_raw: "Test Speaker",
  source_url: "https://archive.example/talks/0007.mp3",
}

test(qase(203, caseTitle(203)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await installIngestMock(page, { items: [READY, PROCESSING] })
  await boot(page, "en", { userDb: "clean" })

  const tiles = page.locator(".grid .track-tile")

  await step(page, 203, 0, async () => {
    await gotoTab(page, "search")
    // The rows arrive on the launch sync cycle, and the whole apply → refresh
    // chain runs on the same thread as the catalog db — generous on purpose.
    const shelf = page.locator(".my-library-shelf")
    await expect(shelf).toBeVisible({ timeout: 60_000 })
    await expect(shelf.locator(".track-tile")).toHaveCount(2)
    await expect(shelf).toContainText(READY.title_raw)
  })

  await step(page, 203, 1, async () => {
    await page.locator(".my-library-shelf .section-more").click()
    await page.waitForURL("**/search/my-library", { timeout: 15_000 })
    await expect(tiles).toHaveCount(2, { timeout: 20_000 })
    // Newest first, so the processing one leads — assert the set, not a slot.
    await expect(page.locator(".grid")).toContainText(READY.title_raw)
    await expect(page.locator(".grid")).toContainText(PROCESSING.title_raw)
  })

  await step(page, 203, 2, async () => {
    await searchInput(page).fill("morning walk")
    await expect(tiles).toHaveCount(1)
    await expect(tiles.first()).toContainText(PROCESSING.title_raw)
  })

  await step(page, 203, 3, async () => {
    // Narrowed to nothing is its own state: the library is not empty, this
    // query is — so the page must not offer the "add your first lecture" copy.
    await searchInput(page).fill("zzzz no lecture says this")
    await expect(tiles).toHaveCount(0)
    await expect(page.locator(".empty-title")).toHaveText("Nothing found")
  })
})

test(qase(204, caseTitle(204)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await installIngestMock(page)
  await boot(page, "en", { userDb: "clean" })

  const banner = page.locator(".library-banner", { hasText: "My library" })

  await step(page, 204, 0, async () => {
    await gotoTab(page, "search")
    await expect(banner).toBeVisible({ timeout: 60_000 })
    await expect(page.locator(".my-library-shelf")).toHaveCount(0)
  })

  await step(page, 204, 1, async () => {
    await banner.click()
    await page.waitForURL("**/search/my-library", { timeout: 15_000 })
    await expect(page.locator(".empty-title")).toHaveText("Your library is empty", {
      timeout: 20_000,
    })
    await expect(page.locator(".empty-message")).toContainText("Ask Sadhu")
  })
})
