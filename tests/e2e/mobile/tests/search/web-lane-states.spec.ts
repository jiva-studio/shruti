import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, trackRows } from "../../support/nav.js"
import {
  installDiscoveryMock,
  UNTITLED_DISCOVERY_HIT,
  DEFAULT_DISCOVERY_HITS,
} from "../../support/discovery-mock.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Everything the internet lane can say besides "here are two lectures".
 *
 * Case 167 covers the shelf when the service answers well; these cover the
 * answers it also gives — a recording the archive filed without a name, a
 * remark about the request itself, a reader that could not be reached, and a
 * question nothing matched. Each is a different line on screen, and telling
 * them apart is the whole point: an empty shelf that means "nothing matches"
 * and one that means "nothing could" are not the same news.
 *
 * The stub is re-registered per spec after `boot`, so it wins over the default
 * one the bootstrap installs (Playwright matches the last registration first).
 */

test(qase(174, caseTitle(174)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await installDiscoveryMock(page, { hits: [UNTITLED_DISCOVERY_HIT] })
  await openLibrary(page)

  await step(page, 174, 0, async () => {
    // A talk filed with a speaker, a passage and a day, and no name of its own
    // is called by the passage it reads — never by the address of its file.
    const tile = page.locator(".carousel-cell .track-tile").first()
    await expect(tile).toBeVisible({ timeout: 20_000 })
    await expect(tile).toContainText("SB 7.5.33–37")
    expect(await tile.innerText()).not.toContain("http")
  })
})

test(qase(175, caseTitle(175)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  const note = "No speaker called “Ioann” is in the index"
  await installDiscoveryMock(page, {
    messages: [{ field: "authors", kind: "matches_nobody", text: note }],
  })
  await openLibrary(page)

  await step(page, 175, 0, async () => {
    // What happened to the request and is not a recording. Without it the lane
    // cannot distinguish a name nobody has from a corpus that holds nothing.
    await expect(page.locator(".lane .lane-note")).toHaveText(note, { timeout: 20_000 })
  })
})

test(qase(176, caseTitle(176)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await installDiscoveryMock(page, { status: 503 })
  await openLibrary(page)

  await step(page, 176, 0, async () => {
    // The reader is unreachable — the exact state a missing token mount
    // produces on a deploy. The lane says so in its own strip...
    await expect(page.locator(".lane .lane-state--muted")).toHaveText(
      "Couldn't reach the internet search right now.",
      { timeout: 20_000 }
    )
  })

  await step(page, 176, 1, async () => {
    // ...and the library below is untouched. A failure out there is never the
    // surface's failure.
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    expect(await trackRows(page).count()).toBeGreaterThan(0)
  })
})

test(qase(177, caseTitle(177)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await installDiscoveryMock(page, { hits: [] })
  await openLibrary(page)

  await step(page, 177, 0, async () => {
    // Nothing matched — which reads differently from the failure above, and
    // must, because one of them is worth trying again.
    await expect(page.locator(".lane .lane-state--muted")).toHaveText(
      "Nothing on the archives we index.",
      { timeout: 20_000 }
    )
  })
})

test(qase(178, caseTitle(178)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  const bodies: unknown[] = []
  await installDiscoveryMock(page, {
    hits: DEFAULT_DISCOVERY_HITS,
    onRequest: (b) => bodies.push(b),
  })
  await openLibrary(page)

  await step(page, 178, 0, async () => {
    // Typing searches the words as written. The sentence-reading path is a
    // different request with a different cost, and the box must not take it.
    await expect(page.locator(".carousel-cell .track-tile").first()).toBeVisible({
      timeout: 20_000,
    })
    expect(bodies.length).toBeGreaterThan(0)
    const last = bodies[bodies.length - 1] as { query?: string; filter?: { text?: string } }
    expect(last.filter?.text).toBeTruthy()
    expect(last.query ?? "").toBe("")
  })
})
