import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, trackSheet } from "../../support/nav.js"
import { installIngestMock } from "../../support/ingest-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * What a tile in the internet lane is once the lecture behind it has been
 * added — and what it must not claim to be while there is nothing behind it.
 *
 * A hit the user has added is a personal-library lecture, so it opens the way
 * the library tile opens it. Before that it is a picture: it reports a stage or
 * offers a plus, and it is not a button (#1788).
 */

/** The two hits `installDiscoveryMock` puts in the lane, in order. */
const WEB_VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
const WEB_FILE_URL = "https://archive.example/talks/0001.mp3"

const ADDED = {
  id: "lib-added",
  status: "ready" as const,
  title_raw: "A lecture already in the library",
  author_raw: "Test Speaker",
  source_url: WEB_VIDEO_URL,
  track_id: "hash-e2e-web",
}

const FETCHING = {
  id: "lib-fetching",
  status: "processing" as const,
  title_raw: "A lecture still being fetched",
  source_url: WEB_VIDEO_URL,
}

/** Ready, but resolving to no track — the tile has nowhere to go. */
const UNRESOLVED = {
  id: "lib-unresolved",
  status: "ready" as const,
  title_raw: "A lecture with no track",
  source_url: WEB_FILE_URL,
  track_id: null,
}

test(qase(336, caseTitle(336)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await installIngestMock(page, { items: [ADDED] })
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tile = page.locator(".carousel-cell .track-tile").first()

  await step(page, 336, 0, async () => {
    // The row arrives on the launch sync cycle, so the tile starts as an offer
    // and becomes a lecture — generous on purpose.
    await expect(tile.locator("button.add")).toHaveCount(0, { timeout: 60_000 })
    await expect(tile).toHaveAttribute("role", "button")
  })

  await step(page, 336, 1, async () => {
    await tile.click()
    const sheet = trackSheet(page)
    await expect(sheet).toBeVisible({ timeout: 20_000 })
    await expect(sheet.locator(".sheet-title")).toHaveText(ADDED.title_raw)
    // Only a resolved personal-library item carries this action — proof the
    // hit was matched back to its own row, not to some corpus track.
    await expect(sheet.locator(".remove-btn")).toBeVisible()
  })
})

test(qase(337, caseTitle(337)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await installIngestMock(page, { items: [FETCHING, UNRESOLVED] })
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tiles = page.locator(".carousel-cell .track-tile")

  await step(page, 337, 0, async () => {
    const fetching = tiles.first()
    await expect(fetching.locator(".ingest-badge .label")).toBeVisible({ timeout: 60_000 })
    await expect(fetching).not.toHaveAttribute("role", "button")
  })

  await step(page, 337, 1, async () => {
    const unresolved = tiles.nth(1)
    // Added, so no plus — and still not openable, so no button either.
    await expect(unresolved.locator("button.add")).toHaveCount(0, { timeout: 60_000 })
    await expect(unresolved).not.toHaveAttribute("role", "button")
    await unresolved.click()
    await expect(trackSheet(page)).toBeHidden()
  })
})
