import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openMyLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"

// The pipeline as the user sees it: one tile, reporting. The orchestrator is
// stubbed (support/ingest-mock.ts) and the run only moves when the spec says so
// — a stage that exists for one poll interval cannot be asserted otherwise.

/** The YouTube hit `installDiscoveryMock` puts first in the web lane. */
const WEB_HIT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

const BROKEN = {
  id: "lib-broken",
  status: "failed" as const,
  title_raw: "A lecture the archive dropped",
  source_url: "https://archive.example/talks/0009.mp3",
  error: "unavailable",
}

test(qase(205, caseTitle(205)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  const ingest = await installIngestMock(page)
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tile = page.locator(".carousel-cell .track-tile").first()
  const label = tile.locator(".ingest-badge .label")

  await step(page, 205, 0, async () => {
    await expect(tile).toBeVisible({ timeout: 20_000 })
    await tile.locator("button.add").click()
    // The row has not synced down yet, so this badge is the store's own record
    // of the submit — the window `useIngestStatusFor` exists to cover.
    await expect(label).toHaveText("Processing", { timeout: 20_000 })
    expect(ingest.submits.map((s) => s.url)).toEqual([WEB_HIT_URL])
  })

  await step(page, 205, 1, async () => {
    await expect(label).toHaveText("Downloading", { timeout: 40_000 })
    // The ring carries the percent, so the label must NOT repeat it.
    await expect(label).not.toContainText("40")
  })

  await step(page, 205, 2, async () => {
    ingest.advance()
    await expect(label).toHaveText("Transcribing", { timeout: 40_000 })
  })

  await step(page, 205, 3, async () => {
    ingest.advance()
    await expect(tile.locator(".ingest-badge")).toHaveCount(0, { timeout: 40_000 })
    await expect(tile.locator("button.add")).toHaveCount(0)
    // A tile the user owns is openable; an offer is not.
    await expect(tile).toHaveAttribute("role", "button")
  })
})

test(qase(206, caseTitle(206)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  const ingest = await installIngestMock(page, { items: [BROKEN] })
  await boot(page, "en", { pro: true, userDb: "clean" })

  const tiles = page.locator(".grid .track-tile")
  const tile = tiles.first()

  await step(page, 206, 0, async () => {
    await openMyLibrary(page)
    await expect(tile).toContainText("This source isn't available.", { timeout: 20_000 })
    await expect(tile.locator("button.corner.failed")).toContainText("Retry")
  })

  await step(page, 206, 1, async () => {
    await tile.locator("button.corner.failed").click()
    await expect(tile.locator(".ingest-badge .label")).toHaveText("Downloading", {
      timeout: 40_000,
    })
    // The re-add carries the row's own source URL — that is what lets the
    // orchestrator map it back to the run that died.
    expect(ingest.submits.map((s) => s.url)).toEqual([BROKEN.source_url])
  })

  await step(page, 206, 2, async () => {
    ingest.advance()
    ingest.advance()
    await expect(tile.locator(".ingest-badge")).toHaveCount(0, { timeout: 40_000 })
    // Restarted in place: the same run id, so the list never grew a second copy.
    await expect(tiles).toHaveCount(1)
  })
})

test(qase(207, caseTitle(207)), { tag: ["@offline", "@subscription"] }, async ({ page }) => {
  const ingest = await installIngestMock(page, { submitStatus: 402, submitErrorCode: "not_pro" })
  // Pro on the device: the client-side gate passes, so the only "no" in the
  // test is the server's.
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tile = page.locator(".carousel-cell .track-tile").first()

  await step(page, 207, 0, async () => {
    await expect(tile).toBeVisible({ timeout: 20_000 })
    await tile.locator("button.add").click()
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 20_000 })
    expect(ingest.submits).toHaveLength(1)
  })

  await step(page, 207, 1, async () => {
    await expect(tile.locator(".ingest-badge")).toHaveCount(0)
    await expect(tile.locator("button.add")).toHaveCount(1)
  })
})
