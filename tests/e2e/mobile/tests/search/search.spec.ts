import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, searchInput, trackRows, trackTitles } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Case 20: the library list populates on open and pages in more on scroll
// (merged with the former infinite-scroll spec). PAGE_SIZE = 50.
test(qase(20, caseTitle(20)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  const rows = trackRows(page)
  let first = 0

  await step(page, 20, 0, async () => {
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    first = await rows.count()
    expect(first).toBeGreaterThan(0)
  })

  await step(page, 20, 1, async () => {
    // Drive Ionic infinite-scroll: scroll the list to the bottom until it pages in.
    const content = page.locator("ion-content").last()
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

// Case 22: the search box is wired to the result set — a no-match query empties
// the list, clearing it restores the catalog.
test(qase(22, caseTitle(22)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await step(page, 22, 0, async () => {
    await expect(trackRows(page).first()).toBeVisible()
    await searchInput(page).fill("zzzqqxnomatch")
    await expect(trackRows(page)).toHaveCount(0, { timeout: 15_000 })
  })

  await step(page, 22, 1, async () => {
    await searchInput(page).fill("")
    await expect(trackRows(page).first()).toBeVisible({ timeout: 15_000 })
  })
})

// Case 164: searching by a title word narrows the list to matching lectures.
test(qase(164, caseTitle(164)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  await openLibrary(page)

  await step(page, 164, 0, async () => {
    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })

    // Take a distinctive word from the first lecture's title (≥ 4 ASCII letters)
    // so the query is real catalog content without hardcoding a specific word.
    const firstTitle = (await trackTitles(page))[0] ?? ""
    const word = (firstTitle.match(/[A-Za-z]{4,}/g) ?? [])[0]
    expect(word, `no searchable word in title "${firstTitle}"`).toBeTruthy()

    await searchInput(page).fill(word)

    // The list narrows to rows whose titles all contain the query (case-insensitive).
    await expect
      .poll(
        async () => {
          const titles = await trackTitles(page)
          return (
            titles.length > 0 && titles.every((t) => t.toLowerCase().includes(word.toLowerCase()))
          )
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  })
})
