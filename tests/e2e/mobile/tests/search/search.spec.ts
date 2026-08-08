import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, searchInput, trackRows, trackTitles } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Case 20: the library list populates on open and pages in more on scroll
// (merged with the former infinite-scroll spec). PAGE_SIZE = 50.
test(qase(20, caseTitle(20)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  const rows = trackRows(page)
  let first = 0

  await step(page, 20, 0, async () => {
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    first = await rows.count()
    expect(first).toBeGreaterThan(0)
  })

  await step(page, 20, 1, async () => {
    // Drive Ionic infinite-scroll: scroll the list to the bottom until it pages
    // in. Scope to the VISIBLE scroller — Ionic keeps every tab's page mounted,
    // and search no longer pushes one on top, so "the last ion-content" is some
    // other tab's rather than this one's.
    const content = page.locator("ion-content:visible").last()
    for (let i = 0; i < 8; i++) {
      await content.evaluate((el: HTMLElement & { scrollToBottom?: (d: number) => Promise<void> }) =>
        el.scrollToBottom?.(0)
      )
      await page.waitForTimeout(700)
      if ((await rows.count()) > first) break
    }
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(first)
  })
})

// Case 22: the three ways the search box narrows the library — by verse
// reference, by a title word, and the no-results empty state — one per step.
test(qase(22, caseTitle(22)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  await step(page, 22, 0, async () => {
    // Verse reference: "bg 1.1" matches the exact verse, with no prefix bleed
    // into 1.10–1.19.
    await searchInput(page).fill("bg 1.1")
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => (await trackTitles(page)).some((t) => /\b1\.1[0-9]\b/.test(t)), {
        timeout: 10_000,
      })
      .toBe(false)
  })

  await step(page, 22, 1, async () => {
    // Title word: a word taken from a lecture title narrows to matching titles.
    // Re-widen first — an EMPTY box is the browsing landing now, not the whole
    // catalog, so "show me everything again" is a broad query.
    await openLibrary(page)
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
    const firstTitle = (await trackTitles(page))[0] ?? ""
    const word = (firstTitle.match(/[A-Za-z]{4,}/g) ?? [])[0]
    expect(word, `no searchable word in title "${firstTitle}"`).toBeTruthy()

    const before = (await trackTitles(page)).join("|")
    await searchInput(page).fill(word)
    // The word re-queries to a different, non-empty set. NOT "every visible
    // title contains it": the index is one combined row per lecture — titles,
    // every reference spelling, locations, tags, dates — so a word can
    // legitimately match through a tag, and which rows the page shows follows
    // the Sort facet. Nor a smaller COUNT: both pages fill to PAGE_SIZE.
    await expect
      .poll(
        async () => {
          const titles = await trackTitles(page)
          return titles.length > 0 && titles.join("|") !== before
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    // The lecture the word came from is still reachable by it.
    await expect(trackRows(page).filter({ hasText: word }).first()).toBeVisible({
      timeout: 15_000,
    })
  })

  await step(page, 22, 2, async () => {
    // No match: a query that matches nothing shows the centered empty state.
    await searchInput(page).fill("zzzqqxnomatch")
    await expect(page.locator(".no-results")).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(".no-results-title")).toBeVisible()
    await expect(trackRows(page)).toHaveCount(0)
  })
})
